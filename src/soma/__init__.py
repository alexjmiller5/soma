"""soma: schema-agnostic personal data store — local-first SQLite, agent-friendly CLI."""

import argparse
import fcntl
import http.client
import json
import os
import re
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

VERSION = "0.2.0"
# Default hosted hub. Any deployment can be targeted by setting hub_url in
# config.json, so the client is not tied to this instance.
DEFAULT_HUB_URL = "https://soma.nqipomyrjb.workers.dev"
POLL_SECONDS = 30  # how often `soma watch` pulls when the hub cannot signal changes
TICK_SECONDS = 1  # how often `soma watch` checks for local changes
CHANGES_WAIT = 25  # seconds one change long poll may be held (the hub's maximum)
SAFETY_SECONDS = 600  # with live change signals, a slow round still catches a missed one

NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')"
DDL_KEYWORDS = {"CREATE", "ALTER", "DROP"}
RENAME_TABLE = re.compile(r"^\s*ALTER\s+TABLE\s+\S+\s+RENAME\s+TO\b", re.IGNORECASE)
RENAME_COLUMN = re.compile(r"^\s*ALTER\s+TABLE\s+\S+\s+RENAME\s+(?!TO\b)", re.IGNORECASE)
CHUNK = 200  # rows per upsert (one JSON parameter regardless of row width)
DERIVE_CHUNK = 50  # max ids per /v1/derive call
RETRY_DELAYS = (1, 4, 15)  # seconds before each retry of an idempotent hub request

PLUMBING_STMTS = [
    f"""CREATE TABLE IF NOT EXISTS _schema_log (
    id INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT ({NOW}),
    ddl TEXT NOT NULL
)""",
    """CREATE TABLE IF NOT EXISTS _sync_state (
    key TEXT PRIMARY KEY,
    value TEXT
)""",
]
PLUMBING = ";\n".join(PLUMBING_STMTS) + ";"

from soma import catalog, changes, legacy

# --- local database ----------------------------------------------------------


def resolve_data_dir() -> Path:
    if override := os.environ.get("SOMA_DATA_DIR"):
        return Path(override)
    xdg = os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share"
    return Path(xdg) / "soma"


def db_path() -> Path:
    return resolve_data_dir() / "soma.db"


SAFE_IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def qi(name: str) -> str:
    """Quote a table/column name for interpolation into SQL. Mirrors the hub's
    `ident()`: anything that is not a bare identifier is refused rather than
    escaped, so no caller can smuggle SQL through a name."""
    if not SAFE_IDENT.match(name or ""):
        raise ValueError(f"unsafe identifier: {name!r}")
    return f'"{name}"'


class _Connection(sqlite3.Connection):
    """`with connect(...)` closes on exit. The stdlib context manager only
    commits/rolls back, and a connection sits in a reference cycle, so an
    un-closed one holds its files until the cyclic GC gets around to it - a
    daemon under launchd's 256-file cap ran out mid-sync."""

    def __exit__(self, *exc):
        try:
            return super().__exit__(*exc)
        finally:
            self.close()


def connect(path: Path, manual_tx: bool = False) -> sqlite3.Connection:
    # Bulk sync and validation can hold the writer beyond SQLite's five-second default.
    conn = sqlite3.connect(
        path, timeout=60, isolation_level=None if manual_tx else "", factory=_Connection
    )
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with connect(path) as conn:
        conn.executescript(PLUMBING)
        upgrade = catalog.has_catalog(conn)
    if upgrade:  # an existing estate: engine tables this version added appear here
        catalog.ensure_catalog(path)
    return path


# `WITH` is deliberately absent: a CTE can end in INSERT/UPDATE/DELETE, so
# every WITH statement goes through the validator (a read-only CTE pays a
# no-op transaction).
READ_KEYWORDS = {"SELECT", "PRAGMA", "EXPLAIN", "VALUES"}


def _first_word(sql: str) -> str:
    return sql.lstrip().split(None, 1)[0].upper() if sql.strip() else ""


def execute_sql(path: Path, sql: str) -> list[dict]:
    if RENAME_TABLE.match(sql):
        raise ValueError(
            "renaming a table through SQL leaves the catalog, provenance and history "
            "pointing at the old name - use `soma table rename OLD NEW`"
        )
    if RENAME_COLUMN.match(sql):
        raise ValueError(
            "renaming a column through SQL leaves its catalog property, history and saved "
            "views pointing at the old name - use `soma property rename TABLE.OLD NEW`"
        )
    if _first_word(sql) in READ_KEYWORDS:
        with connect(path) as conn:
            return [dict(r) for r in conn.execute(sql).fetchall()]

    def run(conn):
        rows = [dict(r) for r in conn.execute(sql).fetchall()]
        if _first_word(sql) in DDL_KEYWORDS:
            conn.execute("INSERT INTO _schema_log (ddl) VALUES (?)", (sql,))
        return rows

    return catalog.write(path, run, ddl=_first_word(sql) in DDL_KEYWORDS)


def insert_rows(path: Path, table: str, rows: list[dict]) -> int:
    def run(conn):
        for row in rows:
            row = catalog.apply_defaults(conn, table, row)
            cols = list(row)
            values = [json.dumps(v) if isinstance(v, (list, dict)) else v for v in row.values()]
            placeholders = ", ".join("?" for _ in cols)
            conn.execute(
                f"INSERT INTO {qi(table)} ({', '.join(qi(c) for c in cols)}) "
                f"VALUES ({placeholders})",
                values,
            )
        return len(rows)

    return catalog.write(path, run)


COLSPEC = re.compile(r"^(?P<col>\w+):(?P<type>\w+)(?P<req>!)?(?:\((?P<opts>[^)]*)\))?$")
# an unrecognized type keeps its raw storage type; the catalog property still
# gets a best-guess catalog type from the storage SQLite ends up with.
_STORAGE_TO_CATALOG_TYPE = {"REAL": "number", "INTEGER": "int"}


def _parse_specs(columns: list[str]) -> list[dict]:
    specs = []
    for c in columns:
        m = COLSPEC.match(c)
        if not m:
            raise ValueError(f"bad column spec {c!r}; expected col:type[!][(a|b)]")
        specs.append(m.groupdict())
    return specs


def _trigger_ddl(name: str) -> str:
    return f"""CREATE TRIGGER {qi(f"{name}_updated_at")} AFTER UPDATE ON {qi(name)} FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
    UPDATE {qi(name)} SET updated_at = ({NOW}) WHERE rowid = NEW.rowid;
END"""


def table_ddl(name: str, columns: list[str]) -> list[str]:
    """The two statements a synced table is made of: CREATE TABLE with the sync
    columns, and its updated_at trigger. One source, so every path that creates
    a table logs byte-identical DDL."""
    specs = _parse_specs(columns)
    user_cols = ",\n    ".join(
        f"{qi(s['col'])} {catalog.STORAGE.get(s['type'].lower(), s['type'].upper())}" for s in specs
    )
    ddl = f"""CREATE TABLE {qi(name)} (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    {user_cols},
    created_at TEXT NOT NULL DEFAULT ({NOW}),
    updated_at TEXT NOT NULL DEFAULT ({NOW}),
    deleted_at TEXT,
    hub_at TEXT
)"""
    return [ddl, _trigger_ddl(name)]


def create_table(
    path: Path, name: str, columns: list[str], *, descriptions: dict[str, str] | None = None
) -> None:
    """Create a table plus a `catalog_properties` row per column.

    Each column is `col:type[!][(a|b|c)]`: `type` is a catalog type (mapped
    to its SQLite storage via `catalog.STORAGE`) or a raw SQLite type used
    as-is; `!` marks the column required; `(a|b|c)` sets select/multi_select
    options.
    """
    ddl, trigger = table_ddl(name, columns)
    descriptions = descriptions or {}
    names = {s["col"] for s in _parse_specs(columns)}
    if descriptions.keys() - names or any(not isinstance(v, str) for v in descriptions.values()):
        raise ValueError("descriptions must map declared columns to text")
    init(path)
    if name not in catalog.ENGINE_TABLES:
        catalog.ensure_catalog(path)

    def run(conn):
        for statement in (ddl, trigger):
            conn.execute(statement)
            conn.execute("INSERT INTO _schema_log (ddl) VALUES (?)", (statement,))
        if name not in catalog.ENGINE_TABLES:
            for col, fields in _column_properties(columns):
                if col in descriptions:
                    fields["description"] = descriptions[col]
                catalog._upsert_in(
                    conn, "catalog_properties", f"{name}.{col}", {"tbl": name, "col": col, **fields}
                )

    catalog.write(path, run, ddl=True)


def _column_properties(columns: list[str]):
    for i, s in enumerate(_parse_specs(columns)):
        t = s["type"].lower()
        storage = catalog.STORAGE.get(t, s["type"].upper())
        cat_type = t if t in catalog.TYPES else _STORAGE_TO_CATALOG_TYPE.get(storage, "text")
        fields = {"type": cat_type, "sort": (i + 1) * 10}
        if s["req"]:
            fields["required"] = 1
        if s["opts"] is not None:
            fields["options"] = [{"v": o.strip()} for o in s["opts"].split("|") if o.strip()]
        yield s["col"], fields


def provision_sidebar_pins(path: Path) -> None:
    """Provision the recognized synced navigation table through normal schema writes."""
    from .sidebar_pins import provision

    provision(path)


def rename_table(path: Path, old: str, new: str) -> None:
    """Rename a table and every reference to it - catalog rows, refs, rule SQL,
    provenance, history - in one transaction, as logged DDL that replays to
    the hub and every replica. The only sanctioned way to rename a table."""
    qi(new)  # validates the identifier
    if old in catalog.CATALOG_TABLES or old.startswith("_"):
        raise ValueError(f"{old} is an engine table")

    def run(conn):
        if not catalog._table_exists(conn, old):
            raise ValueError(f"no such table: {old}")
        if catalog._table_exists(conn, new):
            raise ValueError(f"table already exists: {new}")
        for stmt in (
            f"ALTER TABLE {qi(old)} RENAME TO {qi(new)}",
            # SQLite rewrites the trigger body itself; the NAME must follow the
            # convention too, or a later `soma table create {old}` collides
            f"DROP TRIGGER IF EXISTS {qi(f'{old}_updated_at')}",
            _trigger_ddl(new),
        ):
            conn.execute(stmt)
            conn.execute("INSERT INTO _schema_log (ddl) VALUES (?)", (stmt,))
        catalog.rename_refs(conn, old, new)
        changes.rename(conn, old, new)

    catalog.write(path, run, ddl=True)


def rename_column(path: Path, table: str, old: str, new: str) -> None:
    """Rename a column and every reference to it - its catalog property, the
    table's rules, derivation inputs, provenance, history and saved views - in
    one transaction, as logged DDL that replays to the hub and every replica.
    The only sanctioned way to rename a column."""
    qi(new)  # validates the identifier
    if table in catalog.CATALOG_TABLES or table.startswith("_"):
        raise ValueError(f"{table} is an engine table")
    if {old, new} & catalog.SYNC_COLS:
        raise ValueError(f"{min({old, new} & catalog.SYNC_COLS)} is a sync column")

    def run(conn):
        if not catalog._table_exists(conn, table):
            raise ValueError(f"no such table: {table}")
        cols = {r["name"] for r in conn.execute(f"PRAGMA table_info({qi(table)})")}
        if old not in cols:
            raise ValueError(f"no such column: {table}.{old}")
        if new in cols:
            raise ValueError(f"column already exists: {table}.{new}")
        stmt = f"ALTER TABLE {qi(table)} RENAME COLUMN {qi(old)} TO {qi(new)}"
        conn.execute(stmt)
        conn.execute("INSERT INTO _schema_log (ddl) VALUES (?)", (stmt,))
        catalog.rename_column_refs(conn, table, old, new)

    catalog.write(path, run, ddl=True)


# The dump shape version shared with soma-core (DUMP_HEADER in core/src/backup.ts).
DUMP_HEADER = "-- soma-dump: 1"


def dump_sql(path: Path) -> str:
    with connect(path) as conn:
        return "\n".join([DUMP_HEADER, *conn.iterdump()])


def db_version(path: Path) -> tuple:
    """Cheap local-change fingerprint, no queries: size+mtime of the database AND
    its WAL. In WAL mode writes land in the -wal file and leave the main file
    untouched until a checkpoint, so both must be watched."""
    out = []
    for p in (path, Path(f"{path}-wal")):
        try:
            st = p.stat()
            out.append((st.st_size, st.st_mtime_ns))
        except FileNotFoundError:
            out.append(None)
    return tuple(out)


def db_changed(path: Path, previous) -> tuple[bool, tuple]:
    current = db_version(path)
    return current != previous, current


# --- config ------------------------------------------------------------------


def load_config(data_dir: Path | None = None, *, resolve_auth: bool = True) -> dict:
    """Env overrides saved endpoint preferences; auth honors explicit login/logout state."""
    data_dir = data_dir or resolve_data_dir()
    cfg_path = data_dir / "config.json"
    cfg = json.loads(cfg_path.read_text()) if cfg_path.exists() else {}
    from .background import read_json

    prefs = read_json(data_dir / "background.json")
    if prefs.get("hub_url"):
        current = legacy.hub_url(prefs["hub_url"], DEFAULT_HUB_URL)
        if current != prefs["hub_url"]:
            from .background import update_preferences

            prefs = update_preferences(data_dir, lambda p: p.update(hub_url=current))
        cfg["hub_url"] = prefs["hub_url"]
    cfg.setdefault("hub_url", DEFAULT_HUB_URL)
    cfg.setdefault("commands", {})
    cfg["hub_url"] = validate_hub_url(os.environ.get("SOMA_HUB_URL", cfg["hub_url"]))
    if prefs.get("signed_out") or prefs.get("keychain"):
        cfg["headers"] = {
            key: value
            for key, value in (cfg.get("headers") or {}).items()
            if key.lower() != "authorization"
        }
    if not resolve_auth:
        return cfg
    token = os.environ.get("SOMA_HUB_TOKEN") or None
    if not token and not prefs.get("signed_out") and prefs.get("keychain"):
        from .background import keychain_account
        from .credentials import read_token

        token = read_token(keychain_account(data_dir, cfg["hub_url"])) or legacy.adopt_token(
            data_dir, cfg["hub_url"], DEFAULT_HUB_URL, interactive=True
        )
    elif not token and not prefs.get("signed_out"):
        token = cfg.get("token")
        if not token and cfg.get("token_cmd"):
            token = subprocess.run(
                cfg["token_cmd"], shell=True, capture_output=True, text=True, check=True
            ).stdout.strip()
    cfg["token"] = token
    return cfg


def auth_headers(config: dict) -> dict:
    """Generic credentials: a bearer token plus any extra headers a deployment needs
    (e.g. CF-Access-Client-Id/Secret when the hub sits behind Cloudflare Access)."""
    headers = dict(config.get("headers") or {})
    if config.get("token"):
        if not isinstance(config["token"], str):
            raise ValueError("invalid hub request headers")
        headers["Authorization"] = f"Bearer {config['token']}"
    return _validate_headers(headers)


def _validate_headers(headers: dict) -> dict:
    for name, value in headers.items():
        if (
            not isinstance(name, str)
            or not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", name)
            or not isinstance(value, str)
            or any(ord(c) < 32 or ord(c) == 127 or ord(c) > 255 for c in value)
        ):
            raise ValueError("invalid hub request headers") from None
    return headers


# --- hubs (sync targets) -----------------------------------------------------


def _upsert_sql(
    table: str, cols: list[str], stamp_hub_at: bool = False, *, insert_only: bool = False
) -> str:
    # rows travel as ONE json parameter (D1 caps bind params at ~100/query);
    # `WHERE true` disambiguates a SELECT-source upsert for SQLite's parser.
    # `stamp_hub_at` is the HUB's role, decided by the HUB's schema: hub_at is
    # dropped from whatever the client sent and re-added bound to the hub's own
    # clock, so a push that omits the column still lands stamped rows. A client
    # applying a pull carries the hub's value through as data.
    t = qi(table)
    # the json path uses the RAW column name (it is a JSON key, not SQL)
    if stamp_hub_at:
        cols = [c for c in cols if c != "hub_at"]
        exts = ", ".join([*(f"json_extract(value, '$.{c}')" for c in cols), "?"])
        cols = [*cols, "hub_at"]
    else:
        exts = ", ".join(f"json_extract(value, '$.{c}')" for c in cols)
    sets = ", ".join(f"{qi(c)} = excluded.{qi(c)}" for c in cols if c != "id")
    conflict = (
        "ON CONFLICT(id) DO NOTHING RETURNING id"
        if insert_only
        else f"ON CONFLICT(id) DO UPDATE SET {sets} WHERE excluded.updated_at > {t}.updated_at"
    )
    return (
        f"INSERT INTO {t} ({', '.join(qi(c) for c in cols)}) "
        f"SELECT {exts} FROM json_each(?) WHERE true "
        f"{conflict}"
    )


def _insert_payload(table: str, columns: list[str], rows: list[dict], history=None) -> list[dict]:
    qi(table)
    if history is not None:
        raise ValueError("history attachments are not supported by rows/insert")
    if not isinstance(columns, list) or "id" not in columns or not isinstance(rows, list):
        raise ValueError("rows/insert requires columns including id and a rows list")
    for col in columns:
        qi(col)
    if any(not isinstance(row, dict) for row in rows):
        raise ValueError("rows/insert requires object rows")
    ids = [row.get("id") for row in rows]
    if any(not isinstance(id, str) or not id.strip() for id in ids) or len(ids) != len(set(ids)):
        raise ValueError("rows/insert requires unique nonempty row IDs")
    return [{col: row[col] for col in columns if col in row} for row in rows]


# --- purge ---------------------------------------------------------------------
# The one sanctioned hard delete. A marker row in `purges` names a row (col
# NULL) or one column's history, never its content, and syncs like any row.
# The hub and every replica that holds a marker delete what it covers, stamped
# at or before `purged_at`, and refuse to take such copies back. A copy written
# after the marker (a source re-import) is new data and passes.
PURGES = "purges"
PURGE_COLUMNS = ["tbl:text", "row_id:text", "col:text", "purged_at:text"]


def _purge_index(conn: sqlite3.Connection) -> dict[tuple, list[tuple]]:
    if not catalog._table_exists(conn, PURGES):
        return {}
    index: dict[tuple, list[tuple]] = {}
    for m in conn.execute(
        f"SELECT tbl, row_id, col, purged_at FROM {PURGES} WHERE deleted_at IS NULL"
    ):
        index.setdefault((m["tbl"], m["row_id"]), []).append((m["col"], m["purged_at"]))
    return index


def _covers_row(index: dict, table: str, row: dict) -> bool:
    return any(
        col is None and (row.get("updated_at") or "") <= at
        for col, at in index.get((table, row.get("id")), [])
    )


def _covers_event(index: dict, event: dict) -> bool:
    return any(
        (col is None or col == event.get("col")) and (event.get("created_at") or "") <= at
        for col, at in index.get((event.get("tbl"), event.get("row_id")), [])
    )


def _markers_for(index: dict, table: str, ids: list[str]) -> list[dict]:
    return [
        {"tbl": table, "row_id": rid, "col": col, "purged_at": at}
        for rid in ids
        for col, at in index.get((table, rid), [])
    ]


def _uncovered(index: dict, table: str, rows: list[dict]) -> list[dict]:
    if not index or table == PURGES:
        return rows
    if table == "history":
        return [e for e in rows if not _covers_event(index, e)]
    return [r for r in rows if not _covers_row(index, table, r)]


def apply_purges(conn: sqlite3.Connection, markers: list[dict]) -> None:
    """Hard-delete what each live marker covers, on whatever database `conn` is."""
    exists = lambda t: catalog._table_exists(conn, t)
    for m in markers:
        if m.get("deleted_at"):
            continue
        tbl, rid, col, at = m["tbl"], m["row_id"], m.get("col"), m["purged_at"]
        if col is None:
            if exists(tbl):
                conn.execute(f"DELETE FROM {qi(tbl)} WHERE id = ? AND updated_at <= ?", (rid, at))
            if exists("provenance"):
                conn.execute(
                    "DELETE FROM provenance WHERE updated_at <= ? AND "
                    "((to_kind = ? AND to_ref = ?) OR (from_kind = ? AND from_ref = ?))",
                    (at, tbl, rid, tbl, rid),
                )
        if exists("history"):
            conn.execute(
                "DELETE FROM history WHERE tbl = ? AND row_id = ? AND created_at <= ?"
                + ("" if col is None else " AND col = ?"),
                (tbl, rid, at) if col is None else (tbl, rid, at, col),
            )


def _ensure_purges(path: Path) -> None:
    """Every step checks for itself, so a setup interrupted midway (a locked
    database) is completed by the next purge. The DDL is logged: it replays."""
    ddl, trigger = table_ddl(PURGES, PURGE_COLUMNS)
    with connect(path) as conn:
        has_table = catalog._table_exists(conn, PURGES)
        has_trigger = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?",
            (f"{PURGES}_updated_at",),
        ).fetchone()
        cataloged = catalog._table_exists(conn, "catalog_properties") and conn.execute(
            "SELECT count(*) FROM catalog_properties WHERE tbl = ? AND deleted_at IS NULL",
            (PURGES,),
        ).fetchone()[0] == len(PURGE_COLUMNS)
        documented = (
            catalog._table_exists(conn, "catalog_tables")
            and conn.execute(
                "SELECT 1 FROM catalog_tables WHERE id = ? AND deleted_at IS NULL", (PURGES,)
            ).fetchone()
        )
    if not has_table:
        execute_sql(path, ddl)
    if not has_trigger:
        execute_sql(path, trigger)
    if not cataloged:
        descriptions = {
            "tbl": "Table containing the row or column history to purge.",
            "row_id": "Exact primary key of the affected row.",
            "col": "Column whose history is purged; null means the entire row.",
            "purged_at": "UTC cutoff: copies at or before this instant are purged.",
        }
        for col, fields in _column_properties(PURGE_COLUMNS):
            catalog.set_property(path, PURGES, col, **fields, description=descriptions[col])
    if not documented:
        catalog.set_table(
            path,
            PURGES,
            purpose="Purge markers: each names a row (col empty) or one column's history "
            "that the hub and every replica hard-delete, never the content itself.",
            id_semantics="JSON array [table, row_id, col]; purging again updates purged_at.",
            owner="soma purge",
        )


def purge(path: Path, table: str, row_id: str, cols: list[str] | None = None) -> dict:
    """Remove a row, or its listed columns' history, here and - through sync -
    on the hub and every replica. Redact a column's live value with a normal
    write first; this removes the trail of old values."""
    if (
        table.startswith(("_", "sqlite_"))
        or (table in catalog.CATALOG_TABLES and table != "provenance")
        or table == PURGES
    ):
        raise ValueError(f"{table} is an engine table")
    qi(table)
    with connect(path) as conn:
        if not catalog._table_exists(conn, table):
            raise ValueError(f"no such table: {table}")
        names = {r["name"] for r in conn.execute(f"PRAGMA table_info({qi(table)})")}
        missing = [c for c in cols or [] if c not in names]
        if missing:
            raise ValueError(f"no such column: {table}.{missing[0]}")
    _ensure_purges(path)
    written = 0
    with connect(path) as conn:
        conn.execute("BEGIN IMMEDIATE")
        changes.track(conn)
        now = conn.execute(f"SELECT {NOW}").fetchone()[0]
        for col in cols or [None]:
            mid = json.dumps([table, row_id, col])
            # Purging again moves the marker's time forward, so a copy re-imported
            # since the last purge is covered too.
            conn.execute(
                f"INSERT INTO {PURGES} (id, tbl, row_id, col, purged_at) VALUES (?, ?, ?, ?, ?) "
                "ON CONFLICT(id) DO UPDATE SET purged_at = excluded.purged_at, deleted_at = NULL",
                (mid, table, row_id, col, now),
            )
            written += 1
        markers = conn.execute(
            f"SELECT * FROM {PURGES} WHERE tbl = ? AND row_id = ?", (table, row_id)
        ).fetchall()
        apply_purges(conn, [dict(m) for m in markers])
    return {"markers": written}


class LocalHub:
    """Hub backed by a local SQLite file — used by tests and by the Worker's own logic."""

    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def _query(self, sql: str, params: list | tuple = ()) -> list[dict]:
        with connect(self.path) as conn:
            return [dict(r) for r in conn.execute(sql, tuple(params)).fetchall()]

    def ensure_ready(self) -> None:
        for stmt in PLUMBING_STMTS:
            self._query(stmt)

    def schema_pull(self) -> list[dict]:
        return self._query("SELECT applied_at, ddl FROM _schema_log ORDER BY applied_at, id")

    def schema_push(self, entries: list[dict]) -> int:
        known = {r["ddl"] for r in self.schema_pull()}
        applied = 0
        for e in entries:
            if e["ddl"] in known:
                continue
            try:
                self._query(e["ddl"])
            except Exception as exc:  # replay skips DDL the hub already has
                if not _already_applied(exc):
                    raise
            self._query(
                "INSERT INTO _schema_log (applied_at, ddl) VALUES (?, ?)",
                [e["applied_at"], e["ddl"]],
            )
            applied += 1
        return applied

    def _has_hub_at(self, table: str) -> bool:
        return any(r["name"] == "hub_at" for r in self._query(f"PRAGMA table_info({qi(table)})"))

    def rows_pull(self, table: str, columns: list[str], since: str) -> list[dict]:
        sel = ", ".join(qi(c) for c in columns)
        if not self._has_hub_at(table):  # predates the migration: old behaviour
            return self._query(f"SELECT {sel} FROM {qi(table)} WHERE updated_at > ?", [since or ""])
        # arrival-time cursor, INCLUSIVE: a push stamped in the same millisecond
        # as a cursor read must not be lost. A row with a NULL hub_at is older
        # than everything, so `since = ''` pulls the whole table, NULLs included.
        return self._query(
            f"SELECT {sel} FROM {qi(table)} WHERE ? = '' OR hub_at >= ?",
            [since or "", since or ""],
        )

    def rows_pull_pages(self, table: str, columns: list[str], since: str, after=None):
        """Pages in id order, as the service serves them."""
        rows = sorted(
            (r for r in self.rows_pull(table, columns, since) if after is None or r["id"] > after),
            key=lambda r: r["id"],
        )
        for i in range(0, max(len(rows), 1), CHUNK):
            page = rows[i : i + CHUNK]
            yield page, page[-1]["id"] if i + CHUNK < len(rows) else None

    def rows_push(self, table: str, columns: list[str], rows: list[dict], *, history=None) -> dict:
        return self._rows_write(table, columns, rows, history=history)

    def rows_insert(
        self, table: str, columns: list[str], rows: list[dict], *, history=None
    ) -> dict:
        rows = _insert_payload(table, columns, rows, history)
        return self._rows_write(table, columns, rows, insert_only=True)

    def _rows_write(
        self, table: str, columns: list[str], rows: list[dict], *, history=None, insert_only=False
    ) -> dict:
        qi(table)
        for col in columns:
            qi(col)
        rows = [{col: row[col] for col in columns if col in row} for row in rows]
        rejected, accepted, existing = [], [], []
        with connect(self.path) as conn:
            conn.execute("BEGIN IMMEDIATE")
            # Pushed copies a marker covers are dropped silently: a rejection
            # would pin an un-upgraded replica's push cursor forever. Inserts
            # account for every submitted id and carry new data, so pass.
            if not insert_only:
                purged = _purge_index(conn)
                rows = _uncovered(purged, table, rows)
                history = _uncovered(purged, "history", history or [])
            stamping = any(
                r["name"] == "hub_at" for r in conn.execute(f"PRAGMA main.table_info({qi(table)})")
            )
            now = conn.execute(f"SELECT {NOW}").fetchone()[0]
            hub_at = now if stamping else ""
            # Facts imported by an earlier row can still explain a later revision
            # in this batch, but facts present before the batch cannot be reused.
            has_history = catalog._table_exists(conn, "history")
            remaining = [
                e
                for e in (history or [])
                if not has_history
                or not conn.execute("SELECT 1 FROM history WHERE id=?", (e.get("id"),)).fetchone()
            ]
            history_batch = {"events": remaining, "matched": {}}
            for row in rows:
                # Existing IDs, including tombstones, are not claims about the
                # initializer's content. Do not validate it or fire any SQL write.
                if (
                    insert_only
                    and conn.execute(
                        f"SELECT 1 FROM {qi(table)} WHERE id = ?", (row["id"],)
                    ).fetchone()
                ):
                    existing.append(row["id"])
                    continue
                if not catalog.valid_edit_timestamp(row.get("updated_at")):
                    rejected.append(
                        {
                            "id": row.get("id"),
                            "col": "updated_at",
                            "rule": "required" if row.get("updated_at") is None else "type",
                            "message": "updated_at must be a valid UTC millisecond timestamp.",
                        }
                    )
                    continue
                before = conn.execute(
                    f"SELECT * FROM {qi(table)} WHERE id = ?", (row.get("id"),)
                ).fetchone()
                stale = before and row["updated_at"] <= before["updated_at"]
                conn.execute("SAVEPOINT pushed_row")
                try:
                    events = [e for e in (history or []) if e.get("row_id") == row.get("id")]
                    # For insertion, validate SQLite's actual defaults/types
                    # after writing inside the savepoint, not a guessed row.
                    _, violations = (
                        ([], [])
                        if stale or insert_only
                        else catalog.validate_push(conn, table, [row])
                    )
                    if not violations and not stale:
                        conn.execute(
                            f"CREATE TEMP TABLE temp.{qi('_before_' + table)} AS SELECT * FROM main.{qi(table)} WHERE id = ?",
                            (row.get("id"),),
                        )
                        blob = json.dumps([row])
                        cur = conn.execute(
                            _upsert_sql(
                                table, list(row), stamp_hub_at=stamping, insert_only=insert_only
                            ),
                            [hub_at, blob] if stamping else [blob],
                        )
                        if insert_only and not cur.fetchall():
                            conn.execute("ROLLBACK TO pushed_row")
                            rejected.append(
                                {
                                    "id": row["id"],
                                    "col": None,
                                    "rule": "write-conflict",
                                    "retryable": True,
                                    "message": "No insert receipt; retry against current state.",
                                }
                            )
                            continue
                        actual = dict(
                            conn.execute(
                                f"SELECT * FROM {qi(table)} WHERE id=?", (row["id"],)
                            ).fetchone()
                        )
                        _, violations = catalog.validate_push(
                            conn,
                            table,
                            [row],
                            before_rows={row["id"]: dict(before) if before else None},
                            after_rows={row["id"]: actual},
                        )
                        if (
                            not catalog.valid_edit_timestamp(actual.get("updated_at"))
                            or actual.get("updated_at") != row["updated_at"]
                        ):
                            violations.append(
                                {
                                    "id": row["id"],
                                    "col": "updated_at",
                                    "rule": "type",
                                    "message": "Stored updated_at must match the canonical pushed timestamp.",
                                }
                            )
                        for rule in catalog.rules(conn, tbl=table, kind="invariant"):
                            if rule.get("enforce") and rule.get("tbl") == table:
                                for hit in catalog.run_invariant(
                                    conn, rule, changed_ids=[row.get("id")], now=now
                                ):
                                    violations.append(
                                        {
                                            "id": row.get("id"),
                                            "col": rule.get("col"),
                                            "rule": rule["id"],
                                            "message": rule["text"],
                                        }
                                    )
                        conn.execute(f"DROP TABLE temp.{qi('_before_' + table)}")
                    if not violations and not insert_only:
                        try:
                            catalog.push_history(
                                conn,
                                table,
                                row,
                                dict(before) if before else None,
                                events,
                                now,
                                history_batch,
                            )
                        except ValueError as exc:
                            violations.append(
                                {
                                    "id": row.get("id"),
                                    "col": None,
                                    "rule": "history",
                                    "message": str(exc),
                                }
                            )
                    if violations:
                        conn.execute("ROLLBACK TO pushed_row")
                        rejected.extend(violations)
                    else:
                        accepted.append(row)
                except catalog._HistoryAmbiguity:
                    # Earlier revisions may have imported all originals. Roll back
                    # the request rather than preserve a misleading partial history.
                    conn.rollback()
                    return {
                        "upserted": 0,
                        "rejected": [
                            {
                                "id": submitted.get("id"),
                                "col": None,
                                "rule": "history-ambiguity",
                                "retryable": True,
                                "message": "History matching budget exhausted; split revisions into smaller requests and retry.",
                            }
                            for submitted in rows
                        ],
                        "hub_at": "",
                    }
                finally:
                    if conn.in_transaction:
                        conn.execute("RELEASE pushed_row")
            # The hub logs its own event for an accepted edit; a marker that
            # covers the row removes it again, old value included.
            if not insert_only and table != PURGES:
                apply_purges(conn, _markers_for(purged, table, [r["id"] for r in accepted]))
            if table == PURGES and accepted:
                apply_purges(
                    conn,
                    [
                        dict(m)
                        for m in conn.execute(
                            f"SELECT * FROM {PURGES} WHERE id IN (SELECT value FROM json_each(?))",
                            (json.dumps([r["id"] for r in accepted]),),
                        )
                    ],
                )
        if insert_only:
            return {
                "inserted": [r["id"] for r in accepted],
                "existing": existing,
                "rejected": rejected,
            }
        return {"upserted": len(accepted), "rejected": rejected, "hub_at": hub_at}

    def cursor(self, tables: list[str]) -> str:
        return self.marks(tables)[0]

    def marks(self, tables: list[str]) -> tuple[str, dict[str, str], int]:
        marks = {}
        for t in tables:
            # As the service: a table renamed or dropped by a replay the caller
            # has not run yet has no arrivals.
            if not self._query(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [t]
            ):
                marks[t] = ""
                continue
            col = "hub_at" if self._has_hub_at(t) else "updated_at"
            rows = self._query(f"SELECT max({col}) AS m FROM {qi(t)}")
            marks[t] = rows[0]["m"] or ""
        self.ensure_ready()  # as the service does before every route
        schema = self._query("SELECT coalesce(max(id), 0) AS m FROM _schema_log")[0]["m"]
        return max(marks.values(), default=""), marks, schema

    def derive(self, table: str, ids: list[str], col: str | None = None) -> dict:
        return {"derived": 0, "failed": []}  # derivations run on the hub only


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, *_args, **_kwargs):
        return None


def _open_hub_request(url, headers, *, opener, timeout, data=None, method=None):
    """Validate headers and suppress credential-bearing serialization exceptions."""
    try:
        request = urllib.request.Request(
            url, headers=_validate_headers(headers), data=data, method=method
        )
        return opener.open(request, timeout=timeout)
    except (ValueError, UnicodeError):
        raise ValueError("invalid hub request headers") from None


def validate_hub_url(value: str) -> str:
    """Authenticated hub requests require TLS, except on literal loopback hosts."""
    import ipaddress
    from urllib.parse import urlsplit

    error = (
        "hub URL must use HTTPS (HTTP is allowed only on loopback), "
        "without credentials, query or fragment"
    )
    try:
        if not isinstance(value, str) or any(c.isspace() or ord(c) < 32 for c in value):
            raise ValueError(error)
        parsed = urlsplit(value)
        host = parsed.hostname
        _ = parsed.port  # Reject malformed or out-of-range ports before reading credentials.
        loopback = host == "localhost"
        if host and not loopback:
            try:
                loopback = ipaddress.ip_address(host).is_loopback
            except ValueError:
                pass
        if (
            not host
            or parsed.username is not None
            or parsed.password is not None
            or "?" in value
            or "#" in value
            or "\\" in value
            or not (parsed.scheme == "https" or parsed.scheme == "http" and loopback)
        ):
            raise ValueError(error)
    except ValueError:
        raise ValueError(error) from None
    return value.rstrip("/")


def _transient(exc: BaseException) -> bool:
    """A server error, timeout or dropped connection, as opposed to a refusal."""
    cause = exc.__cause__ if isinstance(exc, RuntimeError) else exc
    if isinstance(cause, urllib.error.HTTPError):
        return cause.code >= 500
    return isinstance(cause, (OSError, http.client.HTTPException))


class HttpHub:
    """Hub reached over HTTP — the deployed service. Knows nothing about any provider."""

    def __init__(self, base_url: str, headers: dict | None = None, timeout: int = 120):
        self.base = validate_hub_url(base_url)
        # A real User-Agent is REQUIRED, not cosmetic: Cloudflare's edge bot
        # protection 403s (error 1010) the default "Python-urllib/x.y" agent
        # before the request ever reaches the Worker.
        self.headers = _validate_headers({"User-Agent": f"soma/{VERSION}", **dict(headers or {})})
        self.timeout = timeout
        self.opener = urllib.request.build_opener(_NoRedirect())

    def _post(self, route: str, body: dict) -> dict:
        try:
            with _open_hub_request(
                f"{self.base}{route}",
                {**self.headers, "Content-Type": "application/json"},
                data=json.dumps(body).encode(),
                opener=self.opener,
                timeout=self.timeout,
            ) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if 300 <= e.code < 400:
                e.close()
                raise RuntimeError(f"hub redirected the request (HTTP {e.code})") from e
            raise RuntimeError(f"hub HTTP {e.code}: {e.read().decode()[:300]}") from e
        except urllib.error.URLError as e:
            raise RuntimeError(f"hub unreachable: {e.reason}") from e

    def _post_idempotent(self, route: str, body: dict) -> dict:
        """Pull pages and LWW pushes are safe to repeat: ride out brief hub failures."""
        for delay in (*RETRY_DELAYS, None):
            try:
                return self._post(route, body)
            except Exception as exc:
                if delay is None or not _transient(exc):
                    raise
                time.sleep(delay)

    def ensure_ready(self) -> None:
        return None  # the service owns its own plumbing

    def schema_pull(self) -> list[dict]:
        return self._post("/v1/schema/pull", {})["entries"]

    def schema_push(self, entries: list[dict]) -> int:
        return self._post("/v1/schema/push", {"entries": entries})["applied"]

    def rows_pull_pages(self, table: str, columns: list[str], since: str, after=None):
        """Yield (rows, cursor): the cursor is the last id a page covers, None at the end."""
        body = {"table": table, "columns": columns, "since": since or "", "limit": CHUNK}
        if after is not None:
            body["after"] = after
        while True:
            page = self._post_idempotent("/v1/rows/pull", body)
            cursor = page.get("next_cursor")
            if cursor is not None and (
                not isinstance(cursor, str) or cursor <= body.get("after", "") or not page["rows"]
            ):
                raise RuntimeError("invalid pull cursor")
            yield page["rows"], cursor
            if cursor is None:  # Older hubs return a complete response without a cursor.
                return
            body["after"] = cursor

    def rows_pull(self, table: str, columns: list[str], since: str) -> list[dict]:
        return [row for rows, _ in self.rows_pull_pages(table, columns, since) for row in rows]

    def rows_push(self, table: str, columns: list[str], rows: list[dict], *, history=None) -> dict:
        # the response also carries the hub_at the hub stamped; nothing reads it
        # - the pull cursor never advances on a push
        def push(part: list[dict]) -> tuple[int, list[dict]]:
            body = {"table": table, "columns": columns, "rows": part}
            if history:
                ids = {r["id"] for r in part}
                body["history"] = [e for e in history if e["row_id"] in ids]
            out = self._post_idempotent("/v1/rows/push", body)
            upserted, rejected = out["upserted"], out.get("rejected", [])
            # The hub asks for a smaller batch when one request runs out of its
            # statement budget; halve those rows until a single row still fails.
            retry = {
                r["id"]
                for r in rejected
                if r.get("retryable") is True or r.get("rule") == "write-budget"
            }
            if len(part) < 2 or not retry:
                return upserted, rejected
            again = [r for r in part if r["id"] in retry]
            rejected = [r for r in rejected if r["id"] not in retry]
            mid = (len(again) + 1) // 2
            for half in (again[:mid], again[mid:]):
                if half:
                    n, bad = push(half)
                    upserted += n
                    rejected += bad
            return upserted, rejected

        total, rejected = 0, []
        for i in range(0, len(rows), CHUNK):
            n, bad = push(rows[i : i + CHUNK])
            total += n
            rejected += bad
        return {"upserted": total, "rejected": rejected}

    def rows_insert(
        self, table: str, columns: list[str], rows: list[dict], *, history=None
    ) -> dict:
        # Validate the whole request before chunking: a duplicate in a later
        # chunk must not allow earlier chunks to commit.
        rows = _insert_payload(table, columns, rows, history)
        result = {"inserted": [], "existing": [], "rejected": []}
        for i in range(0, len(rows), CHUNK):
            chunk = rows[i : i + CHUNK]
            out = self._post("/v1/rows/insert", {"table": table, "columns": columns, "rows": chunk})
            if not isinstance(out, dict) or any(not isinstance(out.get(k), list) for k in result):
                raise RuntimeError("invalid insert response")
            done = out["inserted"] + out["existing"]
            bad = [r.get("id") if isinstance(r, dict) else None for r in out["rejected"]]
            ids = {r["id"] for r in chunk}
            if (
                any(not isinstance(id, str) or id not in ids for id in done + bad)
                or len(done) != len(set(done))
                or set(done) & set(bad)
                or set(done) | set(bad) != ids
            ):
                raise RuntimeError("invalid insert response")
            for key, values in result.items():
                values.extend(out[key])
        return result

    def cursor(self, tables: list[str]) -> str:
        return self.marks(tables)[0]

    def marks(self, tables: list[str]) -> tuple[str, dict[str, str] | None, int | None]:
        """The pull cursor, each table's newest arrival and the schema log's newest
        entry (None for either from a hub too old to say)."""
        out = self._post("/v1/cursor", {"tables": tables})
        return out.get("max_hub_at") or "", out.get("tables"), out.get("schema")

    def changes(self, since: int | None, wait: int) -> int:
        """The hub's change sequence, once it differs from `since` or `wait` runs out."""
        query = f"wait={wait}" + ("" if since is None else f"&since={since}")
        return int(self._get(f"/v1/changes?{query}")["seq"])

    def derive(self, table: str, ids: list[str], col: str | None = None) -> dict:
        body = {"table": table, "ids": ids}
        if col:
            body["col"] = col
        return self._post("/v1/derive", body)

    def _get(self, route: str) -> dict | list | None:
        try:
            with _open_hub_request(
                f"{self.base}{route}", self.headers, opener=self.opener, timeout=self.timeout
            ) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if 300 <= e.code < 400:
                e.close()
                raise RuntimeError(f"hub redirected the request (HTTP {e.code})") from e
            raise RuntimeError(f"hub HTTP {e.code}: {e.read().decode()[:300]}") from e
        except urllib.error.URLError as e:
            raise RuntimeError(f"hub unreachable: {e.reason}") from e

    def stream_append(self, name: str, body: str) -> dict:
        return self._post(f"/v1/streams/{name}/append", json.loads(body))

    def stream_tail(self, name: str):
        return self._get(f"/v1/streams/{name}/tail")

    def stream_manifest(self, name: str) -> dict:
        return self._get(f"/v1/streams/{name}/manifest")

    def stream_batch(self, name: str, records: list) -> dict:
        return self._post(f"/v1/streams/{name}/batch", records)

    def archive_query(self, sql: str) -> dict:
        return self._post("/v1/archive/query", {"sql": sql})

    def files_list(self, prefix: str) -> list[dict]:
        """Every object under a prefix, following the hub's opaque cursors."""
        from urllib.parse import urlencode

        objects, query = [], {"prefix": prefix, "limit": 1000}
        while True:
            page = self._get(f"/v1/files?{urlencode(query)}")
            objects += page["objects"]
            if not page["cursor"]:
                return objects
            query["cursor"] = page["cursor"]

    def files_rm(self, key: str, catalog: bool = False) -> dict:
        """Permanently delete one archive object (full/admin token only)."""
        from urllib.parse import quote

        route = f"/v1/files/{quote(key, safe='/')}" + ("?catalog=1" if catalog else "")
        try:
            with _open_hub_request(
                f"{self.base}{route}",
                self.headers,
                opener=self.opener,
                timeout=self.timeout,
                method="DELETE",
            ) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"hub HTTP {e.code}: {e.read().decode()[:300]}") from e
        except urllib.error.URLError as e:
            raise RuntimeError(f"hub unreachable: {e.reason}") from e

    def token_create(self, name: str, scopes: str) -> dict:
        return self._post("/v1/tokens/create", {"name": name, "scopes": scopes})

    def token_revoke(self, name: str) -> dict:
        return self._post("/v1/tokens/revoke", {"name": name})

    def token_list(self) -> list:
        return self._post("/v1/tokens/list", {})


def hub_from_config(config: dict | None = None) -> HttpHub:
    cfg = config or load_config()
    return HttpHub(cfg["hub_url"], auth_headers(cfg))


# --- streams & archive -------------------------------------------------------

STREAM_RE = r"stream\('([A-Za-z0-9_-]+)'\)"


def expand_stream_sql(sql: str, manifests: dict) -> str:
    """Rewrite stream('name') into DuckDB source unions over the manifest URLs."""
    import re

    def source(match) -> str:
        m = manifests[match.group(1)]
        parts = []
        if m["parquet"]:
            parts.append(
                f"SELECT * FROM read_parquet({json.dumps(m['parquet'])}, union_by_name=true)"
            )
        if m["landing"]:
            parts.append(f"SELECT * FROM read_json({json.dumps(m['landing'])}, union_by_name=true)")
        if not parts:
            raise RuntimeError(f"stream '{match.group(1)}' is empty")
        return "(" + " UNION ALL BY NAME ".join(parts) + ")"

    return re.sub(STREAM_RE, source, sql)


def archive_query_duckdb(sql: str, config: dict) -> str:
    """Fallback query path: expand stream() refs over the manifest and run the SQL
    through the local duckdb CLI against landing/parquet URLs. Exists because R2 SQL
    (the default path, proxied by the hub) is beta — this reads the raw objects.
    The SQL script travels on stdin so the token never appears in `ps`."""
    import re
    import shutil

    duck = shutil.which("duckdb")
    if not duck:
        raise SystemExit("duckdb not found on PATH — install it (nix: pkgs.duckdb)")
    hub = hub_from_config(config)
    names = set(re.findall(STREAM_RE, sql))
    manifests = {n: hub.stream_manifest(n) for n in names}
    headers = auth_headers(config)
    header_map = ", ".join(f"'{k}': '{v}'" for k, v in headers.items())
    script = (
        "INSTALL httpfs; LOAD httpfs;\n"
        f"CREATE SECRET hub (TYPE http, EXTRA_HTTP_HEADERS MAP {{{header_map}}});\n"
        + expand_stream_sql(sql, manifests)
        + ";\n"
    )
    out = subprocess.run(  # noqa: PLW1510 — non-zero handled explicitly below
        [duck, "-json"], input=script, capture_output=True, text=True
    )
    if out.returncode != 0:
        raise RuntimeError(f"duckdb failed: {out.stderr.strip()[:500]}")
    # drop the CREATE SECRET statement's own result line
    lines = [ln for ln in out.stdout.strip().splitlines() if ln.strip() != '[{"Success":true}]']
    return "\n".join(lines)


# --- sync --------------------------------------------------------------------


def _get_state(path: Path, key: str) -> str:
    rows = execute_sql(path, f"SELECT value FROM _sync_state WHERE key = '{key}'")
    return rows[0]["value"] if rows else ""


def _set_state(path: Path, key: str, value: str) -> None:
    with connect(path) as conn:
        conn.execute(
            "INSERT INTO _sync_state (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )


def _already_applied(exc: Exception, ddl: str = "") -> bool:
    """Replay is idempotent-by-skip: a CREATE that already exists, an ADD of a
    column already there, a RENAME of a column that is already gone (a fresh
    replica creates engine tables in their current shape, then replays the log
    that got them there), or a table RENAME whose source is already gone."""
    msg = str(exc).lower()
    if "already exists" in msg or "duplicate column" in msg or "no such column" in msg:
        return True
    return "no such table" in msg and bool(RENAME_TABLE.match(ddl))


def _user_tables(path: Path, conn: sqlite3.Connection | None = None) -> list[str]:
    """catalog_* and provenance first, so a replica always has the contract
    (and the provenance backing derived columns) before the data it governs."""
    sql = "SELECT name FROM sqlite_master WHERE type = 'table'"
    rows = conn.execute(sql).fetchall() if conn is not None else execute_sql(path, sql)
    names = [r["name"] for r in rows if not r["name"].startswith(("_", "sqlite_"))]
    first = [n for n in names if n.startswith("catalog_") or n == "provenance"]
    return sorted(first) + sorted(n for n in names if n not in first)


def _push_order(conn: sqlite3.Connection, tables: list[str]) -> list[str]:
    """Each table after the tables it needs on the hub: its catalog ref targets and
    the tables its enforced invariants read (overlay after txns_*), so a row and
    what it points at land in one round. Catalogs and provenance stay first; a
    cycle falls back to name order, as core's sync does."""
    first = [t for t in tables if t.startswith("catalog_") or t == "provenance"]
    needs = {t: set() for t in tables if t not in first}
    if "catalog_properties" in tables:
        for tbl, target in conn.execute(
            "SELECT tbl, ref_table FROM catalog_properties WHERE deleted_at IS NULL "
            "AND type IN ('ref', 'multi_ref') AND ref_table IS NOT NULL"
        ):
            if tbl in needs and target in needs:
                needs[tbl].add(target)
    if "catalog_rules" in tables:
        for tbl, sql in conn.execute(
            "SELECT tbl, sql FROM catalog_rules WHERE deleted_at IS NULL AND scope = 'table' "
            "AND kind = 'invariant' AND enforce = 1 AND sql IS NOT NULL"
        ):
            if tbl in needs:
                needs[tbl] |= set(re.findall(r"\w+", sql)) & needs.keys()
    ordered, done, left = [], set(), list(needs)
    while left:
        table = next((t for t in left if needs[t] - {t} <= done), left[0])
        left.remove(table)
        ordered.append(table)
        done.add(table)
    return first + ordered


def _apply_local_ddl(path: Path, entry: dict) -> None:
    with connect(path) as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            conn.execute(entry["ddl"])
        except sqlite3.Error as exc:
            if not _already_applied(exc, entry["ddl"]):
                raise
        changes.replay_rename(conn, entry["ddl"])
        conn.execute(
            "INSERT INTO _schema_log (applied_at, ddl) VALUES (?, ?)",
            (entry["applied_at"], entry["ddl"]),
        )


def ensure_hub_at(path: Path) -> bool:
    """Give every user table the hub's arrival-time column. Logged DDL, so one
    replica adding it replays to the hub and to every other replica. Returns
    True if anything was added — the caller then owes one full pull, because
    every existing row still has a NULL hub_at."""
    added = False
    with connect(path) as conn:  # one connection: a round runs this over every table
        missing = [
            t
            for t in _user_tables(path, conn)
            if "hub_at" not in {r["name"] for r in conn.execute(f"PRAGMA table_info({qi(t)})")}
        ]
    for t in missing:
        # The literal DEFAULT backfills every existing row, and because the DDL
        # replays verbatim, the hub and every other replica backfill to the SAME
        # stamp. Without it those rows keep a NULL hub_at, the hub's cursor stays
        # empty, and every sync re-pulls the whole table forever.
        stamp = execute_sql(path, f"SELECT {NOW} AS t")[0]["t"]
        try:
            execute_sql(path, f"ALTER TABLE {qi(t)} ADD COLUMN hub_at TEXT DEFAULT '{stamp}'")
            added = True
        except sqlite3.OperationalError as exc:
            if "duplicate column" not in str(exc).lower():
                raise
    return added


def _marks(hub, tables: list[str]) -> tuple:
    """(cursor, per-table marks, schema log mark); hubs from before the schema
    mark answer with the first two only."""
    pull_cursor, marks, *schema = hub.marks(tables)
    return pull_cursor, marks, schema[0] if schema else None


def sync(path: Path, hub) -> dict:
    """State-based replica sync: schema replay, then pull, then push. LWW on updated_at."""
    path = Path(path).resolve()
    # Separate from the runner's lifetime lock and SQLite's writer lock. All
    # sync callers share this inode, including symlink aliases of the database.
    # Never unlink it: a waiter could otherwise lock a different inode.
    with Path(f"{path}.sync.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("sync already in progress for this database") from None
        return _sync_locked(path, hub)


def _sync_locked(path: Path, hub) -> dict:
    unbound_hub = False
    if isinstance(hub, HttpHub):
        previous_hub = _get_state(path, "hub_url")
        if previous_hub and legacy.hub_url(previous_hub, DEFAULT_HUB_URL) == hub.base:
            _set_state(path, "hub_url", hub.base)
            previous_hub = hub.base
        unbound_hub = not previous_hub
        if previous_hub and previous_hub != hub.base:
            raise ValueError("hub changed; use a fresh data directory for a different hub")
    hub.ensure_ready()
    # before the schema replay, so the ALTERs travel to the hub in this sync
    upgraded = ensure_hub_at(path)
    # Old checkpoints could miss equal revisions, inherit a remote future
    # timestamp, or consume a precommit hub arrival. Repair both directions
    # once, even when that poisoned timestamp is no longer in the future.
    repair = _get_state(path, "checkpoint_version") != "3"

    # A replica whose own log has not moved since its last replay has every
    # table on the hub, so it reads the cursor first and skips the whole-log
    # pull while the hub's log has not moved either.
    local_mark = str(execute_sql(path, "SELECT coalesce(max(id), 0) AS m FROM _schema_log")[0]["m"])
    seen_hub, _, seen_local = _get_state(path, "schema_seen").partition(":")
    early = hasattr(hub, "marks") and not (unbound_hub or repair) and seen_local == local_mark
    marks = schema_mark = None
    if early:
        pull_cursor, marks, schema_mark = _marks(hub, _user_tables(path))
    ddl_applied = 0
    if not early or schema_mark is None or str(schema_mark) != seen_hub:
        local_log = execute_sql(
            path, "SELECT applied_at, ddl FROM _schema_log ORDER BY applied_at, id"
        )
        hub_log = hub.schema_pull()
        hub_ddls = {e["ddl"] for e in hub_log}
        local_ddls = {e["ddl"] for e in local_log}

        unsent = [e for e in local_log if e["ddl"] not in hub_ddls]
        ddl_applied = hub.schema_push(unsent) if unsent else 0
        for entry in hub_log:
            if entry["ddl"] not in local_ddls:
                _apply_local_ddl(path, entry)
                ddl_applied += 1
    # Only a hub mark read before the replay may be trusted next round: one read
    # after it could cover another replica's DDL that this replay never saw.
    schema_seen = f"{schema_mark if early else ''}:{local_mark}"

    # capture the pull cursor BEFORE pulling: the hub writes rows itself
    # (derivations on push and on cron), and anything it writes after this read
    # gets hub_at > pull_cursor, so the next sync still sees it. Read before the
    # replay (above) it is only more conservative: a table the replay adds has
    # no mark and is pulled.
    # `marks` is each table's newest arrival on the hub: a table whose mark
    # never reached our cursor has nothing for us, so it is not asked at all -
    # a quiet round costs a handful of requests instead of one per table.
    if not early:
        if hasattr(hub, "marks"):
            pull_cursor, marks, _ = _marks(hub, _user_tables(path))
        else:
            pull_cursor = hub.cursor(_user_tables(path))
    last_pull = _get_state(path, "last_pull")
    last_push = _get_state(path, "last_push")
    announce_repair = repair and bool(last_pull or last_push)
    if announce_repair:
        print(
            "sync checkpoint recovery: full pull, pushing what the hub lacks, to recover "
            "potentially missed rows; this runs once and resumes where a failure stopped it.",
            file=sys.stderr,
            flush=True,
        )
    # Repair compares each hub page with the local rows in the same id range and
    # pushes only what the hub lacks or holds older (it no-ops the rest anyway).
    # Progress persists per page, so a failure resumes instead of restarting.
    # An unbound replica cannot trust progress made against another endpoint.
    resumable = repair and not unbound_hub
    # A table that just gained hub_at has NULL for every existing row, so the
    # stored cursor would skip all of them: one full pull sets that right.
    # Cursors without an endpoint cannot be trusted. A first HTTP sync
    # verifies the full replica; subsequent rounds use the bound cursors.
    if upgraded or unbound_hub or repair:
        last_pull = ""
    if unbound_hub or repair:
        last_push = ""

    # Serialize with local writers before reading our clock and snapshot.
    # Never derive this checkpoint from rows: pulled revisions may be dated
    # ahead. Release the writer reservation before any network work.
    with connect(path) as snapshot:
        snapshot.execute("BEGIN IMMEDIATE")
        changes.ensure(snapshot)
        dirty_cursor = snapshot.execute("SELECT coalesce(max(seq),0) FROM _sync_dirty").fetchone()[
            0
        ]
        # DDL is a writer too. A table created since schema replay must be
        # included (or fail the round for schema retry), never checkpointed past.
        tables = _push_order(snapshot, _user_tables(path, snapshot))
        candidates, columns = {}, {}
        push_cursor = snapshot.execute(f"SELECT {NOW}").fetchone()[0]
        progress = {}
        if resumable:
            progress = {
                k: v
                for k, v in snapshot.execute(
                    "SELECT key, value FROM _sync_state WHERE key LIKE 'recovery%'"
                )
            }
            if not progress:
                # The pull cursor from before the first page is the one to keep:
                # tables verified earlier are not pulled again before it is used.
                progress = {"recovery_pull": pull_cursor, "recovery_push": push_cursor}
                snapshot.executemany(
                    "INSERT INTO _sync_state (key, value) VALUES (?, ?)", progress.items()
                )
            # Local rows written since recovery began reach the hub like any
            # incremental change, even in tables it has already verified.
            last_push = progress["recovery_push"]
        if last_push > push_cursor:
            last_push = ""  # observed local clock rollback or a future checkpoint
            # Keep recovery due if a later network call fails or rows reject,
            # even if the clock catches up before the next attempt.
            snapshot.execute("UPDATE _sync_state SET value = '' WHERE key = 'checkpoint_version'")
            announce_repair = True
            print(
                "sync checkpoint recovery: local clock is behind the checkpoint; "
                "scanning all local rows.",
                file=sys.stderr,
                flush=True,
            )
        for table in tables:
            columns[table] = [
                r["name"] for r in snapshot.execute(f"PRAGMA table_info({qi(table)})")
            ]
            # Unlogged, like the engine indexes: each replica owns its own.
            # Without it this scan reads every row of every table each round.
            snapshot.execute(
                f"CREATE INDEX IF NOT EXISTS {qi(table + '_updated_at')} "
                f"ON {qi(table)} (updated_at)"
            )
            candidates[table] = [
                dict(r)
                for r in snapshot.execute(
                    f"SELECT * FROM {qi(table)} WHERE updated_at >= ? OR id IN "
                    "(SELECT row_id FROM _sync_dirty WHERE tbl=?)",
                    (last_push, table),
                )
            ]
        pending_history = candidates.get("history", [])
    withheld = set()
    # Purge markers travel first, so this replica deletes what they cover
    # before it can push a stale copy back.
    first = [PURGES] if PURGES in tables else []
    tables = (
        first
        + [t for t in tables if t not in ("history", PURGES)]
        + (["history"] if "history" in tables else [])
    )
    pulled = pushed = 0
    rejected = []
    purged: dict = {}

    def apply(table: str, remote: list[dict]) -> None:
        # `pulled` counts rows the LWW upsert actually APPLIED, not rows
        # received: the sync after a push re-reads its own rows (stamped
        # after this cursor was read) and they land on nothing.
        nonlocal pulled
        with connect(path) as conn:
            for i in range(0, len(remote), CHUNK):
                cur = conn.execute(
                    _upsert_sql(table, columns[table]), (json.dumps(remote[i : i + CHUNK]),)
                )
                pulled += cur.rowcount
                # Short transactions: a `soma sql` writer waits one chunk, not a
                # whole pull. A failure re-pulls; the LWW upsert is idempotent.
                conn.commit()
            if table == PURGES:
                apply_purges(conn, remote)

    def push(table: str, rows: list[dict], events: list[dict]) -> None:
        nonlocal pushed
        if table == "history":
            rows = [r for r in rows if r["id"] not in withheld]
        if not rows:
            return
        out = hub.rows_push(table, columns[table], rows, **({"history": events} if events else {}))
        bad = {r["id"] for r in out["rejected"]}
        withheld.update(e["id"] for e in events if e["row_id"] in bad)
        rejected.extend({"table": table, **r} for r in out["rejected"])
        pushed += out["upserted"]

    def verify(table: str, skip: set) -> None:
        """Recovery for one table: pull every hub page, push local rows it lacks."""
        after = progress.get(f"recovery_after:{table}")
        for page, cursor in hub.rows_pull_pages(table, columns[table], "", after):
            # The id range this page covers, as plain bounds so the key index serves it.
            bounds = [(c, v) for c, v in (("id > ?", after), ("id <= ?", cursor)) if v is not None]
            sql = f"SELECT * FROM {qi(table)}"
            if bounds:
                sql += " WHERE " + " AND ".join(c for c, _ in bounds)
            with connect(path) as conn:
                local = conn.execute(sql, [v for _, v in bounds]).fetchall()
            hub_rows = {r["id"]: r.get("updated_at") or "" for r in page}
            ahead = [
                dict(r)
                for r in local
                if r["id"] not in skip
                and (r["id"] not in hub_rows or (r["updated_at"] or "") > hub_rows[r["id"]])
            ]
            apply(table, _uncovered(purged, table, page))
            ahead = _uncovered(purged, table, ahead)
            events = []
            if ahead and table != "history" and "history" in columns:
                with connect(path) as conn:
                    events = [
                        dict(e)
                        for e in conn.execute(
                            "SELECT * FROM history WHERE tbl = ? AND row_id IN "
                            "(SELECT value FROM json_each(?))",
                            (table, json.dumps([r["id"] for r in ahead])),
                        )
                    ]
            push(table, ahead, _uncovered(purged, "history", events))
            if cursor is not None:
                _set_state(path, f"recovery_after:{table}", cursor)
            after = cursor
        _set_state(path, f"recovery_done:{table}", "1")

    for table in tables:
        cols, mine = columns[table], candidates[table]
        if resumable:
            if f"recovery_done:{table}" not in progress:
                verify(table, {r["id"] for r in mine})
        else:
            # the pull is inclusive (hub_at >= cursor), so the comparison is too
            quiet = marks is not None and last_pull and marks.get(table, last_pull) < last_pull
            remote = [] if quiet else hub.rows_pull(table, cols, last_pull)
            if remote := _uncovered(purged, table, remote):
                apply(table, remote)
        if table == PURGES:
            with connect(path) as conn:
                purged = _purge_index(conn)
        mine = _uncovered(purged, table, mine)
        ids = {r["id"] for r in mine}
        events = _uncovered(
            purged,
            "history",
            [e for e in pending_history if e["tbl"] == table and e["row_id"] in ids],
        )
        push(table, mine, events)

    state = {"last_pull": progress.get("recovery_pull", pull_cursor), "schema_seen": schema_seen}
    if not rejected:
        state.update(last_push=push_cursor, checkpoint_version="3")
        if isinstance(hub, HttpHub):
            state["hub_url"] = hub.base
    with connect(path) as conn:
        # Rejected rows need the hub comparison again; a complete repair needs none.
        conn.execute("DELETE FROM _sync_state WHERE key LIKE 'recovery%'")
        if not rejected:
            # Only acknowledge the frozen generation. Writes made while the
            # network was in flight have larger sequences, even with old stamps.
            conn.execute("DELETE FROM _sync_dirty WHERE seq<=?", (dirty_cursor,))
        conn.executemany(
            "INSERT INTO _sync_state (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            state.items(),
        )
    if announce_repair and not rejected:
        print("sync checkpoint recovery complete; incremental sync restored.", file=sys.stderr)
    return {"pushed": pushed, "pulled": pulled, "ddl_applied": ddl_applied, "rejected": rejected}


def pending_local_writes(path: Path) -> bool:
    """Local writes the last round's snapshot missed because they landed while it
    ran: a dirty receipt (Python writers) or a row stamped between that snapshot
    and now (any writer). Bounded by now, so a pulled row from a clock running
    ahead never keeps rounds going."""
    with connect(path) as conn:
        row = conn.execute("SELECT value FROM _sync_state WHERE key = 'last_push'").fetchone()
        if not row or not row[0]:
            return False
        dirty = catalog._table_exists(conn, "_sync_dirty")
        if dirty and conn.execute("SELECT 1 FROM _sync_dirty LIMIT 1").fetchone():
            return True
        now = conn.execute(f"SELECT {NOW}").fetchone()[0]
        return any(
            conn.execute(
                f"SELECT 1 FROM {qi(t)} WHERE updated_at >= ? AND updated_at <= ? LIMIT 1",
                (row[0], now),
            ).fetchone()
            for t in _user_tables(path, conn)
        )


class RemoteChanges(threading.Thread):
    """Long-polls the hub's change sequence in the background. `take()` reports,
    once, that the hub changed since the last look; `live` is False while the
    channel fails (offline, an older hub), and the caller polls instead."""

    def __init__(self, hub, retry: float = POLL_SECONDS):
        super().__init__(daemon=True)
        self.hub, self.retry = hub, retry
        self.live = None  # unknown until the first answer
        self._changed, self._stopped = threading.Event(), threading.Event()

    def run(self) -> None:
        seq = None
        while not self._stopped.is_set():
            try:
                current = self.hub.changes(seq, CHANGES_WAIT)
            except Exception as exc:  # noqa: BLE001 - the caller's poll covers any failure
                if self.live is not False:  # the class only: a body may carry data
                    print(
                        f"change signal unavailable ({type(exc).__name__}); "
                        f"polling every {self.retry} s",
                        file=sys.stderr,
                        flush=True,
                    )
                self.live = False
                self._stopped.wait(self.retry)
                continue
            if not self.live:
                print(
                    "change signal live: remote edits sync as they land",
                    file=sys.stderr,
                    flush=True,
                )
            self.live = True
            if current != seq:
                # The first answer is news too: a change between the caller's last
                # round and this listener's first look must still start a round.
                seq = current
                self._changed.set()

    def take(self) -> bool:
        if not self._changed.is_set():
            return False
        self._changed.clear()
        return True

    def wait(self, timeout: float) -> bool:
        """The loops' tick: sleeps up to `timeout`, ending early at a signal."""
        return self._changed.wait(timeout)

    def stop(self) -> None:
        self._stopped.set()


def watch(path: Path, hub, poll_seconds: int = POLL_SECONDS, once: bool = False) -> None:
    """Push local changes within ~1s; pull as soon as the hub signals a remote
    change, or every poll_seconds while it cannot."""
    state = db_version(path)
    last_round = float("-inf")
    remote = None if once or not hasattr(hub, "changes") else RemoteChanges(hub, poll_seconds)
    if remote:
        remote.start()
    again = False  # a write landed while the last round ran
    try:
        while True:
            changed, state = db_changed(path, state)
            signalled = remote is not None and remote.take()
            interval = SAFETY_SECONDS if remote is not None and remote.live else poll_seconds
            if changed or signalled or again or time.monotonic() - last_round >= interval:
                again = False
                try:
                    stats = sync(path, hub)
                    if stats["pushed"] or stats["pulled"] or stats["ddl_applied"]:
                        print(json.dumps(stats), flush=True)
                    # The fingerprint below absorbs the round's own writes, and
                    # with them any made meanwhile: those still need pushing.
                    again = not stats["rejected"] and pending_local_writes(path)
                except Exception as e:  # noqa: BLE001 - offline, hub down, or a local
                    # hiccup: keep watching. A launchd restart re-runs the credential
                    # command, and that budget is finite.
                    print(f"sync deferred: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
                if changed:
                    try:
                        findings = catalog.check(path)
                        if findings:
                            print(json.dumps({"check": findings}), file=sys.stderr, flush=True)
                    except Exception as e:  # noqa: BLE001 - never kill the daemon
                        print(f"check failed: {e}", file=sys.stderr, flush=True)
                state = db_version(path)
                last_round = time.monotonic()
            if once:
                return
            if remote is not None:
                remote.wait(TICK_SECONDS)
            else:
                time.sleep(TICK_SECONDS)
    finally:
        if remote:
            remote.stop()


# --- CLI ---------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="soma", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("init", help="create the data dir and database")
    sub.add_parser("path", help="print the database path")
    sub.add_parser("export", help="dump the whole database as SQL text to stdout")
    p_sql = sub.add_parser("sql", help="execute one SQL statement, results as JSON")
    p_sql.add_argument("statement")
    p_insert = sub.add_parser("insert", help="bulk-insert rows from a JSON array on stdin")
    p_insert.add_argument("table")
    sub.add_parser("sync", help="sync once with the hub")
    p_check = sub.add_parser("check", help="whole-estate read-only report of catalog violations")
    p_check.add_argument("--as-of", dest="as_of")
    p_audit = sub.add_parser("audit", help="run audit rules' commands, report findings")
    p_audit.add_argument("id", nargs="?", help="run only this rule")
    p_infer = sub.add_parser("infer", help="propose catalog properties for uncataloged columns")
    p_infer.add_argument("table", nargs="?")
    p_infer.add_argument(
        "--apply", action="store_true", help="write the proposals via property set"
    )
    p_infer.add_argument("--min-rows", dest="min_rows", type=int, default=20)
    p_doc = sub.add_parser("doc", help="render the catalog as markdown")
    p_doc.add_argument("table", nargs="?")
    p_watch = sub.add_parser("watch", help="sync continuously (push instantly, poll for pulls)")
    p_watch.add_argument("--poll", type=int, default=POLL_SECONDS)
    p_login = sub.add_parser("login", help="enroll this device through the browser")
    p_login.add_argument("--hub-url", help="hub endpoint (optional for the hosted service)")
    p_login.add_argument("--name", help="label shown in the device approval page")
    p_login.add_argument(
        "--no-browser", action="store_true", help="print the approval URL without opening it"
    )
    p_login.add_argument(
        "--token-stdin",
        action="store_true",
        help="validate and save an existing device token from stdin",
    )
    p_login.add_argument(
        "--profile", help="enroll with this hub-configured access profile instead of full access"
    )
    p_login.add_argument(
        "--start",
        metavar="STATE_FILE",
        type=Path,
        help="headless, with --profile: write a pending enrollment (0600) and print its "
        "approval URL; nothing is stored in Keychain",
    )
    p_login.add_argument(
        "--claim",
        metavar="STATE_FILE",
        type=Path,
        help="headless: print the approved token from a --start state file, then delete it",
    )
    p_login.add_argument(
        "--wait", action="store_true", help="with --claim: poll up to 300 s for the approval"
    )
    sub.add_parser("logout", help="revoke and remove this device credential")
    p_background = sub.add_parser("background", help="enable, disable or inspect background sync")
    bg_sub = p_background.add_subparsers(dest="background_command", required=True)
    bg_enable = bg_sub.add_parser("enable", help="turn on background sync")
    bg_enable.add_argument("--hub-url", help="hub endpoint (optional for the hosted service)")
    bg_auth = bg_enable.add_mutually_exclusive_group()
    bg_auth.add_argument(
        "--token-stdin", action="store_true", help="save a token from stdin in macOS Keychain"
    )
    bg_auth.add_argument("--token-command", help="command that supplies the background token")
    bg_sub.add_parser("disable", help="stop syncing after the current round finishes")
    bg_sub.add_parser("status", help="show enabled state, runner and last sync result")
    bg_run = bg_sub.add_parser(
        "run", help="supervised runner (provided by the Home Manager module)"
    )
    bg_run.add_argument("--poll", type=int, default=POLL_SECONDS)
    p_purge = sub.add_parser(
        "purge", help="hard-delete a row, or a column's history, here and on every replica"
    )
    p_purge.add_argument("table")
    p_purge.add_argument("id", help="the row id")
    p_purge.add_argument(
        "--col", action="append", help="purge only this column's history (repeatable)"
    )
    p_derive = sub.add_parser(
        "derive", help="request the hub derive a column for rows selected locally"
    )
    p_derive.add_argument("ref", help="<table>.<column>")
    p_derive.add_argument("--where", help="SQL WHERE clause narrowing which rows to derive")
    p_stream = sub.add_parser("stream", help="append-only stream operations (hub-backed)")
    s_sub = p_stream.add_subparsers(dest="stream_command", required=True)
    p_sappend = s_sub.add_parser("append", help="append one JSON record from stdin")
    p_sappend.add_argument("name")
    p_stail = s_sub.add_parser("tail", help="print the latest record")
    p_stail.add_argument("name")
    p_simport = s_sub.add_parser(
        "import", help="bulk-import records (NDJSON or a JSON array on stdin), batched"
    )
    p_simport.add_argument("name")
    p_simport.add_argument("--chunk", type=int, default=500)
    p_archive = sub.add_parser("archive", help="analytical queries over streams (DuckDB)")
    a_sub = p_archive.add_subparsers(dest="archive_command", required=True)
    p_aq = a_sub.add_parser("query", help="SQL over the archive (soma.events), results as JSON")
    p_aq.add_argument("statement")
    p_aq.add_argument(
        "--raw",
        action="store_true",
        help="query raw landing/parquet objects with local duckdb via stream('name') sources",
    )
    p_files = sub.add_parser("files", help="retained files in the hub archive")
    f_sub = p_files.add_subparsers(dest="files_command", required=True)
    p_flist = f_sub.add_parser("list", help="list every object under a key prefix, as JSON")
    p_flist.add_argument("prefix", help="key prefix, e.g. raw/flighty/ (needs files:read on it)")
    p_frm = f_sub.add_parser("rm", help="permanently delete one object (full token; logged)")
    p_frm.add_argument("key")
    p_frm.add_argument("--yes", action="store_true", help="confirm the permanent delete")
    p_frm.add_argument(
        "--catalog", action="store_true", help="allow a key under __r2_data_catalog/ (Iceberg)"
    )
    p_token = sub.add_parser("token", help="scoped client tokens (admin token required)")
    k_sub = p_token.add_subparsers(dest="token_command", required=True)
    p_tc = k_sub.add_parser("create", help="mint a scoped token (value shown ONCE)")
    p_tc.add_argument("name")
    p_tc.add_argument(
        "--scopes",
        default="full",
        help="comma list of grants; see docs/consumer-access.md before minting one",
    )
    p_tr = k_sub.add_parser("revoke", help="revoke a token by name")
    p_tr.add_argument("name")
    k_sub.add_parser("list", help="list tokens (names/scopes, never values)")
    p_table = sub.add_parser("table", help="table operations")
    t_sub = p_table.add_subparsers(dest="table_command", required=True)
    t_provision = t_sub.add_parser("provision", help="install a supported shared table schema")
    t_provision.add_argument("schema", choices=["sidebar-pins"])
    p_create = t_sub.add_parser("create", help="create a table with sync columns")
    p_create.add_argument("name")
    p_create.add_argument("columns", nargs="+", metavar="name:type")
    p_create.add_argument(
        "--description",
        action="append",
        default=[],
        metavar="COLUMN=TEXT",
        help="describe a column in the creation transaction (repeatable)",
    )
    t_rename = t_sub.add_parser(
        "rename", help="rename a table and every catalog/provenance/history reference to it"
    )
    t_rename.add_argument("old")
    t_rename.add_argument("new")
    t_set = t_sub.add_parser("set", help="describe a table in the catalog")
    t_set.add_argument("name")
    for f in (
        "kind",
        "purpose",
        "id_semantics",
        "provenance",
        "owner",
        "consumers",
        "description",
        "display",
    ):
        t_set.add_argument(f"--{f.replace('_', '-')}", dest=f)
    p_prop = sub.add_parser("property", help="catalog properties (the per-column contract)")
    pr_sub = p_prop.add_subparsers(dest="property_command", required=True)
    pr_set = pr_sub.add_parser("set", help="upsert a property: <table>.<column>")
    pr_set.add_argument("ref")
    pr_set.add_argument("--type", dest="type")
    pr_set.add_argument("--label")
    pr_set.add_argument("--sort", type=int)
    pr_set.add_argument("--required", type=int, choices=(0, 1))
    pr_set.add_argument("--default", dest="default_value")
    pr_set.add_argument(
        "--options",
        help="JSON array of {v,d,sort,color} (color: a Notion palette name) or a comma list of values",
    )
    pr_set.add_argument("--options-sql", dest="options_sql")
    pr_set.add_argument("--min-items", dest="min_items", type=int)
    pr_set.add_argument("--max-items", dest="max_items", type=int)
    pr_set.add_argument("--pattern")
    pr_set.add_argument("--ref-table", dest="ref_table")
    pr_set.add_argument("--derived-by", dest="derived_by")
    pr_set.add_argument("--inputs", help="comma list of columns")
    pr_set.add_argument("--immutable", type=int, choices=(0, 1))
    pr_set.add_argument("--deprecated", type=int, choices=(0, 1))
    pr_set.add_argument("--description")
    pr_set.add_argument("--source")
    pr_set.add_argument("--source-ref", dest="source_ref")
    pr_list = pr_sub.add_parser("list", help="list properties, optionally for one table")
    pr_list.add_argument("table", nargs="?")
    pr_rm = pr_sub.add_parser("rm", help="soft-delete a property: <table>.<column>")
    pr_rm.add_argument("ref")
    pr_rename = pr_sub.add_parser(
        "rename",
        help="rename a column and every catalog/history/view reference to it: <table>.<column> NEW",
    )
    pr_rename.add_argument("ref")
    pr_rename.add_argument("new")
    p_rule = sub.add_parser("rule", help="catalog rules (invariant, doctrine, audit)")
    ru_sub = p_rule.add_subparsers(dest="rule_command", required=True)
    ru_set = ru_sub.add_parser("set", help="upsert a rule by id")
    ru_set.add_argument("id")
    ru_set.add_argument("--scope", choices=("estate", "table", "column"))
    ru_set.add_argument("--tbl")
    ru_set.add_argument("--col")
    ru_set.add_argument("--kind", choices=("invariant", "doctrine", "audit"))
    ru_set.add_argument("--text")
    ru_set.add_argument("--sql")
    ru_set.add_argument("--cmd")
    ru_set.add_argument("--enforce", type=int, choices=(0, 1))
    ru_list = ru_sub.add_parser("list", help="list rules, optionally for one table")
    ru_list.add_argument("table", nargs="?")
    ru_rm = ru_sub.add_parser("rm", help="soft-delete a rule")
    ru_rm.add_argument("id")
    args = parser.parse_args(argv)

    if not os.environ.get("SOMA_DATA_DIR"):
        legacy.adopt_data_dir(resolve_data_dir())
    path = db_path()
    from .login import LoginError

    try:
        return _dispatch(args, path)
    except LoginError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    except catalog.ValidationError as e:
        print(
            json.dumps({"rejected": [v.as_dict() for v in e.violations]}, indent=2), file=sys.stderr
        )
        return 1
    except ValueError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1


def _dispatch(args: argparse.Namespace, path: Path) -> int:
    if args.command == "background":
        from .background import command

        if args.background_command == "run" and args.poll < 1:
            raise ValueError("poll interval must be at least one second")
        return command(args, path.parent)
    elif args.command == "login":
        from . import login as enrollment

        headless = {"--profile": args.profile, "--start": args.start, "--name": args.name}
        headless |= {"--hub-url": args.hub_url, "--token-stdin": args.token_stdin}
        if args.claim:
            if any(headless.values()) or args.no_browser:
                raise ValueError("--claim takes only the state file and --wait")
            token = enrollment.claim_enrollment(args.claim, wait=args.wait)
            print(token, flush=True)
            args.claim.unlink()
        elif args.wait:
            raise ValueError("--wait requires --claim")
        elif args.start:
            if not args.profile or args.token_stdin:
                raise ValueError("--start requires --profile and cannot read a token")
            print(
                json.dumps(
                    enrollment.start_enrollment(
                        path.parent,
                        args.start,
                        hub_url=args.hub_url,
                        profile=args.profile,
                        name=args.name,
                    )
                )
            )
        else:
            print(
                json.dumps(
                    enrollment.login(
                        path.parent,
                        hub_url=args.hub_url,
                        name=args.name,
                        profile=args.profile,
                        no_browser=args.no_browser,
                        token_stdin=args.token_stdin,
                    )
                )
            )
    elif args.command == "logout":
        from .login import logout

        print(json.dumps(logout(path.parent)))
    elif args.command == "init":
        init(path)
        print(path)
    elif args.command == "path":
        print(path)
    elif args.command == "export":
        print(dump_sql(path))
    elif args.command == "sql":
        print(json.dumps(execute_sql(path, args.statement), indent=2))
    elif args.command == "insert":
        n = insert_rows(path, args.table, json.load(sys.stdin))
        print(f"inserted {n} rows into {args.table}")
    elif args.command == "purge":
        print(json.dumps(purge(path, args.table, args.id, args.col)))
    elif args.command == "sync":
        stats = sync(path, hub_from_config())
        print(json.dumps(stats))
        if stats["rejected"]:
            print(json.dumps({"rejected": stats["rejected"]}, indent=2), file=sys.stderr)
    elif args.command == "check":
        findings = catalog.check(path, as_of=args.as_of)
        print(json.dumps(findings, indent=2))
        return 1 if findings else 0
    elif args.command == "audit":
        findings = catalog.audit(path, rule_id=args.id, commands=load_config().get("commands"))
        print(json.dumps(findings, indent=2))
        return 1 if findings else 0
    elif args.command == "infer":
        proposals = catalog.infer(path, args.table, min_rows=args.min_rows)
        print(json.dumps(proposals, indent=2))
        if args.apply:
            for p in proposals:
                kwargs = {k: v for k, v in p.items() if k not in ("tbl", "col")}
                catalog.set_property(path, p["tbl"], p["col"], **kwargs)
            print(f"applied {len(proposals)}")
    elif args.command == "doc":
        with connect(path) as conn:
            print(catalog.doc(conn, args.table), end="")
    elif args.command == "watch":
        init(path)
        watch(path, hub_from_config(), poll_seconds=args.poll)
    elif args.command == "derive":
        tbl, col = args.ref.split(".", 1)
        cfg = load_config()
        if not cfg.get("token"):
            print(
                "soma derive requires a hub token: set SOMA_HUB_TOKEN, config.json's "
                "token, or token_cmd",
                file=sys.stderr,
            )
            return 1
        where = f" AND ({args.where})" if args.where else ""
        ids = [
            r["id"]
            for r in execute_sql(path, f"SELECT id FROM {qi(tbl)} WHERE deleted_at IS NULL{where}")
        ]
        hub = hub_from_config(cfg)
        derived, failed = 0, []
        for i in range(0, len(ids), DERIVE_CHUNK):
            out = hub.derive(tbl, ids[i : i + DERIVE_CHUNK], col)
            derived += out["derived"]
            failed += out.get("failed", [])
        print(json.dumps({"derived": derived, "failed": failed}))
        return 1 if failed else 0
    elif args.command == "stream":
        hub = hub_from_config()
        if args.stream_command == "append":
            print(json.dumps(hub.stream_append(args.name, sys.stdin.read())))
        elif args.stream_command == "import":
            raw = sys.stdin.read().strip()
            records = (
                json.loads(raw)
                if raw.startswith("[")
                else [json.loads(line) for line in raw.splitlines() if line.strip()]
            )
            total = 0
            for i in range(0, len(records), args.chunk):
                total += hub.stream_batch(args.name, records[i : i + args.chunk])["count"]
                print(f"  {total}/{len(records)}", file=sys.stderr)
            print(json.dumps({"imported": total}))
        else:
            print(json.dumps(hub.stream_tail(args.name), indent=2))
    elif args.command == "archive":
        if args.raw:
            print(archive_query_duckdb(args.statement, load_config()))
        else:
            print(json.dumps(hub_from_config().archive_query(args.statement), indent=2))
    elif args.command == "files":
        if args.files_command == "list":
            print(json.dumps(hub_from_config().files_list(args.prefix), indent=2))
        elif not args.yes:
            raise ValueError(f"files rm permanently deletes {args.key}; pass --yes to confirm")
        else:
            print(json.dumps(hub_from_config().files_rm(args.key, args.catalog), indent=2))
    elif args.command == "token":
        hub = hub_from_config()
        if args.token_command == "create":
            print(json.dumps(hub.token_create(args.name, args.scopes), indent=2))
        elif args.token_command == "revoke":
            print(json.dumps(hub.token_revoke(args.name)))
        else:
            print(json.dumps(hub.token_list(), indent=2))
    elif args.command == "table":
        if args.table_command == "provision":
            provision_sidebar_pins(path)
        elif args.table_command == "create":
            descriptions = {}
            for entry in args.description:
                col, separator, description = entry.partition("=")
                if not separator or col in descriptions:
                    raise ValueError("each description must be a distinct COLUMN=TEXT")
                descriptions[col] = description
            create_table(path, args.name, args.columns, descriptions=descriptions)
            print(f"created table {args.name}")
        elif args.table_command == "rename":
            rename_table(path, args.old, args.new)
            print(f"renamed {args.old} -> {args.new}")
        else:
            fields = {
                k: v
                for k, v in vars(args).items()
                if k
                in (
                    "kind",
                    "purpose",
                    "id_semantics",
                    "provenance",
                    "owner",
                    "consumers",
                    "description",
                    "display",
                )
                and v is not None
            }
            if "consumers" in fields:
                raw = fields["consumers"].strip()
                fields["consumers"] = (
                    json.loads(raw) if raw.startswith("[") else [s.strip() for s in raw.split(",")]
                )
            print(json.dumps(catalog.set_table(path, args.name, **fields), indent=2))
    elif args.command == "property":
        if args.property_command == "set":
            tbl, col = args.ref.split(".", 1)
            skip = {"command", "property_command", "ref"}
            fields = {k: v for k, v in vars(args).items() if k not in skip and v is not None}
            if "options" in fields:
                raw = fields["options"].strip()
                fields["options"] = (
                    json.loads(raw)
                    if raw.startswith("[")
                    else [{"v": s.strip()} for s in raw.split(",")]
                )
            if "inputs" in fields:
                fields["inputs"] = [s.strip() for s in fields["inputs"].split(",")]
            print(json.dumps(catalog.set_property(path, tbl, col, **fields), indent=2))
        elif args.property_command == "list":
            with connect(path) as conn:
                print(json.dumps(catalog.properties(conn, args.table), indent=2))
        elif args.property_command == "rename":
            tbl, col = args.ref.split(".", 1)
            rename_column(path, tbl, col, args.new)
            print(f"renamed {args.ref} -> {tbl}.{args.new}")
        else:
            tbl, col = args.ref.split(".", 1)
            catalog.rm_property(path, tbl, col)
            print(f"removed {args.ref}")
    elif args.command == "rule":
        if args.rule_command == "set":
            skip = {"command", "rule_command", "id"}
            fields = {k: v for k, v in vars(args).items() if k not in skip and v is not None}
            print(json.dumps(catalog.set_rule(path, args.id, **fields), indent=2))
        elif args.rule_command == "list":
            with connect(path) as conn:
                print(json.dumps(catalog.rules(conn, args.table), indent=2))
        else:
            catalog.rm_rule(path, args.id)
            print(f"removed {args.id}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
