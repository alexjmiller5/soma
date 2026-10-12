"""Catalog engine: typed properties, rules, derivations, provenance.

Pure over a sqlite3 connection. No CLI, no network. The CLI in __init__ calls
into this; nothing here knows about hubs or argv.
"""

import hashlib
import json
import math
import re
import socket
import sqlite3
import subprocess
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

CATALOG_TABLES = {
    "catalog_tables": [
        "kind:text",
        "purpose:text",
        "id_semantics:text",
        "provenance:text",
        "owner:text",
        "consumers:text",
        "description:text",
        # the column whose value titles a row in a UI (pickers, search, links)
        "display:text",
    ],
    "catalog_properties": [
        "tbl:text",
        "col:text",
        "label:text",
        "sort:integer",
        "type:text",
        "required:integer",
        "default_value:text",
        "options:text",
        "options_sql:text",
        "min_items:integer",
        "max_items:integer",
        "pattern:text",
        "ref_table:text",
        "derived_by:text",
        "inputs:text",
        "immutable:integer",
        "deprecated:integer",
        "description:text",
        "source:text",
        "source_ref:text",
    ],
    "catalog_rules": [
        "scope:text",
        "tbl:text",
        "col:text",
        "kind:text",
        "text:text",
        "sql:text",
        "cmd:text",
        "enforce:integer",
    ],
    "catalog_log": ["tbl:text", "row_id:text", "action:text", "payload:text"],
    # Every edit to every cataloged table, one row per changed cell, written in
    # the same transaction as the edit. Updates only: an insert is already
    # `created_at` plus the row, and a cell's first change records its original
    # value in `old`, so updates alone reconstruct the full timeline.
    "history": [
        "tbl:text",
        "row_id:text",
        "col:text",
        "old:text",
        "new:text",
        "origin:text",
    ],
    # ONE table for every value's origin: hub derivations (rel=derived_from,
    # id `<to_kind>:<to_ref>:<field>`) and observation edges a client writes
    # (a text, an email, a photo backing a value; id
    # `<from_kind>:<from_ref>:<to_ref>`). Engine-created so it exists from
    # birth, but cataloged and validated like a user table - it is last here
    # because cataloging it needs every other engine table to exist.
    "provenance": [
        "from_kind:select!(photo|imessage|email|manual)",
        "from_ref:text!",
        "to_kind:select!",
        "to_ref:text!",
        "rel:select!(evidence_of|mentions|imported_from|derived_from)",
        "field:text",
        "detail:json",
        "asserted_by:text!",
        "inputs_hash:text",
        "value_hash:text",
        "produced_at:text",
    ],
}
ENGINE_TABLES = set(CATALOG_TABLES) - {"provenance"}

# Indexes the engine's own query patterns need (provenance lookups by target
# row, by source observation; history by edited row). Ensured on every catalog
# op with CREATE INDEX IF NOT EXISTS and never logged to `_schema_log`: each
# replica and the hub own their indexes, exactly like the engine tables.
ENGINE_INDEXES = {
    "provenance": {
        "provenance_to": ("to_kind", "to_ref", "field"),
        "provenance_from": ("from_kind", "from_ref"),
    },
    "history": {"history_row": ("tbl", "row_id", "col")},
}


def ensure_indexes(conn: sqlite3.Connection) -> None:
    """Create every engine index whose table exists; idempotent, unlogged."""
    for tbl, indexes in ENGINE_INDEXES.items():
        if not _table_exists(conn, tbl):
            continue
        for name, cols in indexes.items():
            conn.execute(
                f"CREATE INDEX IF NOT EXISTS {qi(name)} ON {qi(tbl)} "
                f"({', '.join(qi(c) for c in cols)})"
            )


# Sync columns that move on every write and say nothing a reader wants to replay.
HISTORY_SKIP = {"updated_at", "hub_at"}

HISTORY_PROPERTIES = {
    "tbl": "The table the edited row lives in (follows the table through `soma table rename`).",
    "row_id": "The edited row's id.",
    "col": "The column that changed. `deleted_at` going from null to a stamp is the row's soft delete.",
    "old": "The cell's value before the edit, as SQLite rendered it (null for a cell that was empty).",
    "new": "The cell's value after the edit.",
    "origin": "Hostname of the machine that made the edit (a pulled row is never re-logged: the origin replica logged it).",
}
HISTORY_TABLE = {
    "purpose": "Every edit to every cataloged user table (never provenance or the catalog itself), one row per changed cell, written in the same transaction as the edit - the answer to 'when did this become X'. Engine-written; never edit by hand.",
    "id_semantics": "random; `created_at` IS the edit time (ISO-8601 UTC ms).",
    "owner": "the engine (`catalog.write`)",
}

# The parts of the provenance contract the `col:type` spec cannot say.
PROVENANCE_PROPERTIES = {
    "from_kind": {
        "options_sql": "SELECT DISTINCT derived_by FROM catalog_properties WHERE derived_by IS NOT NULL AND deleted_at IS NULL",
        "description": "What kind of thing this came from: an observation kind (photo, imessage, email, manual, or any option you add) or a hub derivation `http:<name>` - every derived_by in the catalog is allowed automatically.",
    },
    "from_ref": {
        "description": "The source's own stable id (message GUID, mail id, photo UUID, archive key). For a derivation: the endpoint's _source_ref, else the inputs hash. Never a URL - links are derived from kind + ref.",
    },
    "to_kind": {
        "options_sql": "SELECT name FROM sqlite_master WHERE type = 'table' AND substr(name, 1, 1) != '_' AND name NOT LIKE 'catalog!_%' ESCAPE '!' AND name NOT LIKE 'sqlite%' AND name NOT IN ('provenance', 'history')",
        "description": "The table of the row this is about (any user table; add an option for a kind that lives outside soma).",
    },
    "to_ref": {"description": "The id of that row."},
    "rel": {
        "description": "How the source relates to the row: evidence_of (a direct observation backs it), mentions (came up; proves nothing alone), imported_from (the row was created from this source), derived_from (the hub computed the field from this derivation).",
    },
    "field": {
        "description": "The column this backs, when it backs one value rather than the row as a whole. Null for imported_from and whole-row evidence.",
    },
    "detail": {
        "description": "JSON, properties of the PAIR only: cue (the quoted fragment), confidence (high|medium|low), dist_m. Never attributes of the source - follow from_kind + from_ref for those.",
    },
    "asserted_by": {
        "description": "Who made the claim: hub (a derivation), a person's name, script:<name>, agent:<session id>.",
    },
    "inputs_hash": {
        "description": "Derivations only: hash of the inputs the hub derived from. Stale when it no longer matches the row."
    },
    "value_hash": {
        "description": "Derivations only: hash of the value the hub wrote; a hand edit no longer matches it."
    },
    "produced_at": {"description": "Derivations only: when the hub wrote the value."},
}

TYPES = {
    "text",
    "markdown",
    "number",
    "int",
    "bool",
    "date",
    "datetime",
    "date_or_datetime",
    "json",
    "select",
    "multi_select",
    "ref",
    "multi_ref",
    "url",
    "email",
    "phone",
}
STORAGE = {
    "text": "TEXT",
    "markdown": "TEXT",
    "number": "REAL",
    "int": "INTEGER",
    "bool": "INTEGER",
    "date": "TEXT",
    "datetime": "TEXT",
    "date_or_datetime": "TEXT",
    "json": "TEXT",
    "select": "TEXT",
    "multi_select": "TEXT",
    "ref": "TEXT",
    "multi_ref": "TEXT",
    "url": "TEXT",
    "email": "TEXT",
    "phone": "TEXT",
}
RULE_KINDS = {"invariant", "doctrine", "audit"}
ORIGIN = socket.gethostname()  # stamped on every history row this machine writes
JSON_COLS = {"options", "inputs", "consumers"}


def _pkg():
    # lazy: the package imports this module
    import soma

    return soma


def qi(name: str) -> str:
    """Quote an identifier for SQL interpolation (see soma.qi)."""
    return _pkg().qi(name)


# --- catalog tables ----------------------------------------------------------


def _table_exists(conn: sqlite3.Connection, name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone()
    return row is not None


def has_catalog(conn: sqlite3.Connection) -> bool:
    return _table_exists(conn, "catalog_properties")


_ensuring = False


def ensure_catalog(path: Path) -> None:
    """Create the catalog tables through the logged-DDL path so they sync."""
    global _ensuring
    if _ensuring:
        return  # the outer call is mid-bootstrap; its set_* writes re-enter here
    _ensuring = True
    try:
        _ensure_catalog(path)
    finally:
        _ensuring = False


def _ensure_catalog(path: Path) -> None:
    pkg = _pkg()
    with pkg.connect(path) as conn:
        missing = [t for t in CATALOG_TABLES if not _table_exists(conn, t)]
    for t in missing:
        pkg.create_table(path, t, CATALOG_TABLES[t])
    # Columns added to an engine table after estates existed: logged DDL, so the
    # first replica to upgrade carries them to the hub and every other replica
    # (a second replica's duplicate ALTER is skipped on replay).
    for t, specs in CATALOG_TABLES.items():
        have = {r["name"] for r in pkg.execute_sql(path, f"PRAGMA table_info({qi(t)})")}
        for spec in specs:
            col, typ = spec.split(":", 1)
            if col not in have:
                storage = STORAGE.get(typ.rstrip("!").split("(", 1)[0], typ.upper())
                pkg.execute_sql(path, f"ALTER TABLE {qi(t)} ADD COLUMN {qi(col)} {storage}")
    if "provenance" in missing:
        for col, fields in PROVENANCE_PROPERTIES.items():
            set_property(path, "provenance", col, **fields)
        set_table(
            path,
            "provenance",
            purpose="Every value's origin, one table: hub derivations and the observations (a text, an email, a photo, an import) that back a row or one of its columns.",
            id_semantics="derivations: <to_kind>:<to_ref>:<field>; observation edges: <from_kind>:<from_ref>:<to_ref> - one edge per source/row pair, so re-running a pass is idempotent.",
            owner="the hub (derivations); scripts and agents (edges)",
        )
    # keyed on the description row, not on `missing`: an estate that predates
    # history gets the table lazily from the write path (see `write`) and its
    # documentation here, on the next catalog op.
    with pkg.connect(path) as conn:
        documented = conn.execute(
            "SELECT 1 FROM catalog_tables WHERE id = 'history' AND deleted_at IS NULL"
        ).fetchone()
    if not documented:
        for col, description in HISTORY_PROPERTIES.items():
            set_property(path, "history", col, description=description)
        set_table(path, "history", **HISTORY_TABLE)
    with pkg.connect(path) as conn:
        ensure_indexes(conn)


def _parse(row: dict) -> dict:
    out = dict(row)
    for c in JSON_COLS:
        if c in out and isinstance(out[c], str):
            out[c] = json.loads(out[c])
    return out


def properties(conn: sqlite3.Connection, tbl: str | None = None) -> list[dict]:
    if not has_catalog(conn):
        return []
    sql = "SELECT * FROM catalog_properties WHERE deleted_at IS NULL"
    args: tuple = ()
    if tbl:
        sql += " AND tbl = ?"
        args = (tbl,)
    sql += " ORDER BY sort, col"
    return [_parse(r) for r in conn.execute(sql, args).fetchall()]


def rules(conn: sqlite3.Connection, tbl: str | None = None, kind: str | None = None) -> list[dict]:
    if not has_catalog(conn):
        return []
    sql = "SELECT * FROM catalog_rules WHERE deleted_at IS NULL"
    args: list = []
    if tbl:
        sql += " AND (tbl = ? OR scope = 'estate')"
        args.append(tbl)
    if kind:
        sql += " AND kind = ?"
        args.append(kind)
    sql += " ORDER BY id"
    return [dict(r) for r in conn.execute(sql, args).fetchall()]


def cataloged_tables(conn: sqlite3.Connection) -> list[str]:
    if not has_catalog(conn):
        return []
    rows = conn.execute(
        "SELECT DISTINCT tbl FROM catalog_properties WHERE deleted_at IS NULL ORDER BY tbl"
    ).fetchall()
    return [r[0] for r in rows if r[0] not in ENGINE_TABLES]


def _upsert(path: Path, table: str, row_id: str, fields: dict) -> dict:
    """Upsert one catalog row and log it. JSON-encodes list/dict fields."""
    ensure_catalog(path)
    return write(path, lambda conn: _upsert_in(conn, table, row_id, fields))


def _upsert_in(conn, table: str, row_id: str, fields: dict) -> dict:
    """Catalog mutation inside its caller's checked transaction."""
    enc = {k: (json.dumps(v) if isinstance(v, (list, dict)) else v) for k, v in fields.items()}
    existing = conn.execute(f"SELECT 1 FROM {qi(table)} WHERE id = ?", (row_id,)).fetchone()
    if existing:
        sets = ", ".join([*(f"{qi(k)} = ?" for k in enc), "deleted_at = NULL"])
        conn.execute(
            f"UPDATE {qi(table)} SET {sets} WHERE id = ?",
            [*enc.values(), row_id],
        )
    else:
        if table == "catalog_properties":
            enc.setdefault("type", "text")  # a bare `--immutable 1` still yields a typed column
        cols = ["id", *enc]
        conn.execute(
            f"INSERT INTO {qi(table)} ({', '.join(qi(c) for c in cols)}) "
            f"VALUES ({', '.join('?' for _ in cols)})",
            [row_id, *enc.values()],
        )
    conn.execute(
        "INSERT INTO catalog_log (tbl, row_id, action, payload) VALUES (?, ?, 'set', ?)",
        (table, row_id, json.dumps(fields, sort_keys=True)),
    )
    row = conn.execute(f"SELECT * FROM {qi(table)} WHERE id = ?", (row_id,)).fetchone()
    return _parse(dict(row))


def _soft_delete(path: Path, table: str, row_id: str) -> None:
    def run(conn):
        conn.execute(f"UPDATE {qi(table)} SET deleted_at = updated_at WHERE id = ?", (row_id,))
        conn.execute(
            "INSERT INTO catalog_log (tbl, row_id, action, payload) VALUES (?, ?, 'rm', NULL)",
            (table, row_id),
        )

    write(path, run)


# Option chip colors: the Notion palette names, stored lowercase (core OPTION_COLORS).
OPTION_COLORS = (
    "default",
    "gray",
    "brown",
    "orange",
    "yellow",
    "green",
    "blue",
    "purple",
    "pink",
    "red",
)


def _option_colors(options: list) -> list:
    out = []
    for o in options:
        if isinstance(o, dict) and "color" in o:
            o = dict(o)
            color = o.pop("color")
            if color is not None:
                name = color.strip().lower() if isinstance(color, str) else color
                if name not in OPTION_COLORS:
                    raise ValueError(f"option color {color!r}; one of {', '.join(OPTION_COLORS)}")
                o["color"] = name
        out.append(o)
    return out


def set_property(path: Path, tbl: str, col: str, **fields) -> dict:
    if isinstance(fields.get("options"), list):
        fields["options"] = _option_colors(fields["options"])
    if "type" in fields and fields["type"] not in TYPES:
        raise ValueError(f"unknown type {fields['type']!r}; one of {sorted(TYPES)}")
    if fields.get("derived_by") and not fields["derived_by"].startswith("http:"):
        raise ValueError("derived_by must start with 'http:' (derivations run on the hub)")
    if fields.get("required") and fields.get("derived_by"):
        raise ValueError(
            "a derived column cannot be required: it is filled by the hub after the row lands"
        )
    return _upsert(path, "catalog_properties", f"{tbl}.{col}", {"tbl": tbl, "col": col, **fields})


def rm_property(path: Path, tbl: str, col: str) -> None:
    _soft_delete(path, "catalog_properties", f"{tbl}.{col}")


def set_rule(path: Path, rule_id: str, **fields) -> dict:
    if "kind" in fields and fields["kind"] not in RULE_KINDS:
        raise ValueError(f"unknown kind {fields['kind']!r}; one of {sorted(RULE_KINDS)}")
    if fields.get("kind") == "invariant" and not fields.get("sql"):
        raise ValueError("an invariant needs sql: the SELECT whose rows are the violations")
    if fields.get("enforce") and fields.get("tbl"):
        with _pkg().connect(path) as conn:
            if _table_exists(conn, fields["tbl"]) and not _has_sync_cols(conn, fields["tbl"]):
                raise ValueError(
                    f"{fields['tbl']} cannot be enforced: it lacks the sync columns "
                    "(id, updated_at) that soma table create injects"
                )
    if fields.get("scope") == "estate" and fields.get("enforce"):
        raise ValueError(
            "an estate-scoped rule cannot be enforced: only soma check runs it. "
            "Write a per-table rule to enforce on the write path."
        )
    if fields.get("sql"):
        check_rule_sql(fields["sql"])
        with _pkg().connect(path) as conn:
            compile_sql(conn, fields["sql"], fields.get("tbl"))
    return _upsert(path, "catalog_rules", rule_id, fields)


def rm_rule(path: Path, rule_id: str) -> None:
    _soft_delete(path, "catalog_rules", rule_id)


def set_table(path: Path, table_id: str, **fields) -> dict:
    if fields.get("display"):
        with _pkg().connect(path) as conn:
            cols = {r["name"] for r in conn.execute(f"PRAGMA table_info({qi(table_id)})")}
        if fields["display"] not in cols:
            raise ValueError(f"{table_id} has no column {fields['display']!r} to title its rows")
    return _upsert(path, "catalog_tables", table_id, fields)


# --- row validation (pure) ---------------------------------------------------


@dataclass
class Violation:
    tbl: str
    row_id: str | None
    col: str | None
    rule: str
    message: str

    def as_dict(self) -> dict:
        return {
            "tbl": self.tbl,
            "row_id": self.row_id,
            "col": self.col,
            "rule": self.rule,
            "message": self.message,
        }


class ValidationError(Exception):
    def __init__(self, violations: list[Violation]):
        self.violations = violations
        super().__init__("\n".join(f"{v.tbl}[{v.row_id}].{v.col}: {v.message}" for v in violations))


DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
DATETIME_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
PHONE_RE = re.compile(r"^\+?[0-9 ()\-.]{5,}$")


def _empty(v) -> bool:
    return v is None or v == "" or (isinstance(v, list) and len(v) == 0)


def _as_list(v):
    if isinstance(v, str):
        try:
            v = json.loads(v)
        except ValueError:
            return None
    return v if isinstance(v, list) else None


def _same(a, b) -> bool:
    la, lb = _as_list(a), _as_list(b)
    if la is not None and lb is not None:
        return la == lb
    return a == b


def _allowed(prop: dict, extra_options) -> list[str]:
    vals = [o["v"] for o in (prop.get("options") or [])]
    if prop.get("options_sql") and extra_options:
        vals += [x for x in extra_options(prop) if x not in vals]
    return vals


def validate_row(
    props, before, after, *, in_derive=(), ref_ok=None, extra_options=None, touched=None
):
    """Spec order: deprecated, derived, immutable, required, type, options,
    cardinality, pattern, ref. First failure per column wins.

    `touched` (a set, or None for "every column") names the columns a partial
    write actually carries; `after` is then the MERGED row. Whole-row rules
    (required) still see every column, but the per-value checks only judge what
    the writer wrote - a stored value is not this write's claim."""
    tbl = props[0]["tbl"] if props else after.get("_tbl", "")
    rid = after.get("id")
    out: list[Violation] = []

    def fail(col, rule, message):
        out.append(Violation(tbl, rid, col, rule, message))

    for p in props:
        col = p["col"]
        v = after.get(col)
        was = before.get(col) if before else None
        changed = (not _empty(v)) if before is None else (not _same(v, was))
        label = p.get("label") or col

        if touched is not None and col not in touched:
            if p.get("required") and _empty(v):
                fail(col, "required", f"{label} is required.")
            continue
        # Deprecated = kept but hidden: a stored value rides along unjudged; only
        # a write that sets a new value is refused (clearing one is allowed).
        if p.get("deprecated"):
            if changed and not _empty(v):
                fail(col, "deprecated", f"{col} is deprecated. Never write it.")
            continue
        if p.get("derived_by") and changed and col not in in_derive:
            fail(
                col, "derived", f"{col} is derived by {p['derived_by']} on the hub. Never write it."
            )
            continue
        if p.get("immutable") and before is not None and changed:
            fail(col, "immutable", f"{col} is set once and never changed.")
            continue
        if p.get("required") and _empty(v):
            fail(col, "required", f"{label} is required.")
            continue
        if _empty(v):
            continue

        t = p.get("type", "text")
        if t in ("number", "int"):
            # match JS `Number(v)`: booleans and `1_000` are not numbers there
            if isinstance(v, bool) or (isinstance(v, str) and "_" in v):
                fail(col, "type", f"{label} must be a number.")
                continue
            try:
                n = float(v)
            except (TypeError, ValueError):
                fail(col, "type", f"{label} must be a number.")
                continue
            if not math.isfinite(n):
                fail(col, "type", f"{label} must be a finite number.")
                continue
            if t == "int" and n != int(n):
                fail(col, "type", f"{label} must be an integer.")
                continue
        elif t == "bool" and v not in (0, 1, True, False):
            fail(col, "type", f"{label} must be 0 or 1.")
            continue
        elif t == "date" and not (isinstance(v, str) and DATE_RE.match(v)):
            fail(col, "type", f"{label} must be YYYY-MM-DD.")
            continue
        elif t == "datetime" and not (isinstance(v, str) and DATETIME_RE.match(v)):
            fail(col, "type", f"{label} must be ISO-8601 UTC with milliseconds.")
            continue
        elif t == "date_or_datetime" and not (
            isinstance(v, str) and (DATE_RE.match(v) or DATETIME_RE.match(v))
        ):
            fail(col, "type", f"{label} must be YYYY-MM-DD or ISO-8601 UTC with milliseconds.")
            continue
        elif t == "json":
            try:
                json.loads(v) if isinstance(v, str) else json.dumps(v)
            except (TypeError, ValueError):
                fail(col, "type", f"{label} must be JSON.")
                continue
        elif t == "url" and not (isinstance(v, str) and v.startswith(("http://", "https://"))):
            fail(col, "type", f"{label} must be an http(s) URL.")
            continue
        elif t == "email" and not (isinstance(v, str) and EMAIL_RE.match(v)):
            fail(col, "type", f"{label} must be an email address.")
            continue
        elif t == "phone" and not (isinstance(v, str) and PHONE_RE.match(v)):
            fail(col, "type", f"{label} must be a phone number.")
            continue
        elif t == "select":
            allowed = _allowed(p, extra_options)
            if allowed and v not in allowed:
                fail(
                    col,
                    "options",
                    f"{v!s} is not an option for {col}. Allowed: {', '.join(allowed)}",
                )
                continue
        elif t in ("multi_select", "multi_ref"):
            items = _as_list(v)
            if items is None:
                fail(col, "type", f"{label} must be a JSON array.")
                continue
            if t == "multi_select":
                allowed = _allowed(p, extra_options)
                bad = [x for x in items if allowed and x not in allowed]
                if bad:
                    fail(
                        col,
                        "options",
                        f"Not options for {col}: {', '.join(map(str, bad))}. Allowed: {', '.join(allowed)}",
                    )
                    continue
            if p.get("min_items") and len(items) < p["min_items"]:
                fail(col, "min_items", f"{label} needs at least {p['min_items']}.")
                continue
            if p.get("max_items") and len(items) > p["max_items"]:
                fail(col, "max_items", f"{label} allows at most {p['max_items']}.")
                continue

        if p.get("pattern") and isinstance(v, str) and not re.fullmatch(p["pattern"], v):
            fail(col, "pattern", f"{label} is not in the expected form.")
            continue

        if t == "ref" and ref_ok and p.get("ref_table") and not ref_ok(p["ref_table"], v):
            fail(col, "ref", f"No {p['ref_table']} row with id {v}.")
            continue
        if t == "multi_ref" and ref_ok and p.get("ref_table"):
            missing = [x for x in _as_list(v) if not ref_ok(p["ref_table"], x)]
            if missing:
                fail(col, "ref", f"No {p['ref_table']} row: {', '.join(map(str, missing))}")
                continue
    return out


# --- write path --------------------------------------------------------------


def _ref_ok(conn):
    def ok(ref_table, rid):
        if not _table_exists(conn, ref_table):
            return False
        return (
            conn.execute(
                f"SELECT 1 FROM {qi(ref_table)} WHERE id = ? AND deleted_at IS NULL", (rid,)
            ).fetchone()
            is not None
        )

    return ok


def _extra_options(conn):
    def extra(prop):
        return [r[0] for r in conn.execute(prop["options_sql"]).fetchall()]

    return extra


def apply_defaults(conn: sqlite3.Connection, tbl: str, row: dict) -> dict:
    out = dict(row)
    for p in properties(conn, tbl):
        d = p.get("default_value")
        if d is None or p["col"] in out:
            continue
        if d.startswith("sql:"):
            out[p["col"]] = conn.execute(f"SELECT ({d[4:]})").fetchone()[0]
        else:
            out[p["col"]] = d
    return out


def _has_sync_cols(conn: sqlite3.Connection, tbl: str) -> bool:
    """The write path finds changed rows by `id` and `updated_at`; a table
    without them (raw `CREATE TABLE`) cannot be checked per row."""
    cols = {r[1] for r in conn.execute(f"PRAGMA main.table_info({qi(tbl)})").fetchall()}
    return {"id", "updated_at"} <= cols


def _validated_tables(conn: sqlite3.Connection) -> list[str]:
    """Tables the write path checks: those with catalog properties, plus any
    table an ENFORCED invariant names (a rule on a raw `soma sql` table still
    runs) - but only when that table can actually be checked, so a check-only
    rule on a legacy table never breaks every write in the database."""
    named = set(cataloged_tables(conn))
    if _table_exists(conn, "catalog_rules"):
        named |= {
            r["tbl"]
            for r in rules(conn, kind="invariant")
            if r.get("tbl")
            and r.get("enforce")
            and _table_exists(conn, r["tbl"])
            and _has_sync_cols(conn, r["tbl"])
        }
    # Catalog properties are editable definitions, so explicit table invariants
    # must cover their changes too. Other engine-managed rows stay excluded.
    return sorted(named - (ENGINE_TABLES - {"catalog_properties"}))


def write(path: Path, fn, *, ddl: bool = False):
    """Run fn(conn) in one transaction; validate every changed row in every
    cataloged table; ROLLBACK and raise ValidationError on any violation."""
    pkg = _pkg()
    conn = pkg.connect(path, manual_tx=True)
    try:
        conn.execute("BEGIN IMMEDIATE")
        tables = [t for t in _validated_tables(conn) if _table_exists(conn, t)]
        if tables and not ddl and not _table_exists(conn, "history"):
            # an estate cataloged before history existed: create it here, as
            # logged DDL, so the first edit after an upgrade is not lost. Not
            # on the DDL path, where fn may be ensure_catalog creating it.
            for stmt in pkg.table_ddl("history", CATALOG_TABLES["history"]):
                conn.execute(stmt)
                conn.execute("INSERT INTO _schema_log (ddl) VALUES (?)", (stmt,))
        t0 = conn.execute(f"SELECT {pkg.NOW}").fetchone()[0]
        pkg.changes.track(conn)
        marks = {}
        for t in tables:
            # ponytail: whole-table snapshot per write; scope by rowid past ~1M rows
            conn.execute(
                f"CREATE TEMP TABLE temp.{qi(f'_before_{t}')} AS "
                f"SELECT rowid AS _rowid, * FROM {qi(t)}"
            )
            marks[t] = conn.execute(f"SELECT coalesce(max(rowid), 0) FROM {qi(t)}").fetchone()[0]
        try:
            result = fn(conn)
            violations, changes = _validate_changed(conn, marks, t0)
            if ddl:
                for rid in compile_all(conn):
                    violations.append(
                        Violation(
                            "catalog",
                            rid,
                            None,
                            "compile",
                            f"{rid} no longer compiles after this DDL.",
                        )
                    )
        except Exception:
            conn.execute("ROLLBACK")
            raise
        if violations:
            conn.execute("ROLLBACK")
            raise ValidationError(violations)
        if changes and _table_exists(conn, "history"):
            conn.executemany(
                "INSERT INTO history (tbl, row_id, col, old, new, origin) VALUES (?, ?, ?, ?, ?, ?)",
                [(*c, ORIGIN) for c in changes],
            )
        conn.execute("COMMIT")
        return result
    finally:
        conn.close()


def _validate_changed(conn, marks, t0) -> tuple[list[Violation], list[tuple]]:
    """Validate every changed row; also return the cell diffs of UPDATEd rows
    as (tbl, row_id, col, old, new) - the history the write leaves behind."""
    out: list[Violation] = []
    changes: list[tuple] = []
    for t, max_rowid in marks.items():
        if not _table_exists(conn, t):
            continue  # fn dropped it
        # Changed rows come from the snapshot diff, never a clock comparison:
        # `updated_at >= t0` both over-reports (a legacy row written in the
        # same millisecond, or a pulled row dated ahead, is not this write's
        # business) and under-reports (an UPDATE inside that same millisecond
        # leaves updated_at untouched).
        # Only the columns both shapes have: after a DROP/RENAME COLUMN a row
        # whose sole difference is that column has not changed.
        before_t = f"temp.{qi(f'_before_{t}')}"
        snap = [
            r[1] for r in conn.execute(f"PRAGMA temp.table_info({qi(f'_before_{t}')})").fetchall()
        ]
        live = {r[1] for r in conn.execute(f"PRAGMA table_info({qi(t)})").fetchall()}
        shared_names = [c for c in snap[1:] if c in live]
        shared = [qi(c) for c in shared_names]
        rows = conn.execute(
            f"SELECT * FROM {qi(t)} WHERE rowid > ? OR rowid IN (SELECT _rowid FROM "
            f"(SELECT {', '.join(['rowid AS _rowid'] + shared)} FROM {qi(t)} "
            f"EXCEPT SELECT {', '.join(['_rowid'] + shared)} FROM {before_t}))",
            (max_rowid,),
        ).fetchall()
        if not rows:
            continue
        props = properties(conn, t)
        for r in rows:
            after = dict(r)
            b = conn.execute(f"SELECT * FROM {before_t} WHERE id = ?", (after["id"],)).fetchone()
            before = dict(b) if b else None
            if before:
                before.pop("_rowid", None)
            if before and t not in CATALOG_TABLES:  # user data only, never provenance
                changes += [
                    (t, after["id"], c, before[c], after[c])
                    for c in shared_names
                    if c not in HISTORY_SKIP and before[c] != after[c]
                ]
            if after.get("deleted_at"):
                continue  # a tombstone's values are history, not a claim to check
            out += validate_row(
                props,
                before,
                after,
                ref_ok=_ref_ok(conn),
                extra_options=_extra_options(conn),
            )
        changed_ids = [r["id"] for r in rows]
        for rule in rules(conn, tbl=t, kind="invariant"):
            if not rule.get("enforce") or rule.get("tbl") != t:
                continue
            hits = run_invariant(conn, rule, changed_ids=changed_ids, now=t0)
            for h in hits:
                out.append(Violation(t, h.get("id"), rule.get("col"), rule["id"], rule["text"]))
    return out, changes


# --- rename -------------------------------------------------------------------


def _rekey(conn, table: str, old_id: str, new_id: str, **changes) -> None:
    """Move a row to a new id the sync-safe way: insert the copy, soft-delete
    the original (an in-place id change would leave the hub's copy alive and
    pull it straight back)."""
    row = dict(conn.execute(f"SELECT * FROM {qi(table)} WHERE id = ?", (old_id,)).fetchone())
    row.update(changes, id=new_id, hub_at=None)
    row.pop("updated_at")  # fresh stamp: the copy must be newer than the push cursor
    cols = list(row)
    conn.execute(
        f"INSERT INTO {qi(table)} ({', '.join(qi(c) for c in cols)}) "
        f"VALUES ({', '.join('?' for _ in cols)})",
        list(row.values()),
    )
    conn.execute(f"UPDATE {qi(table)} SET deleted_at = updated_at WHERE id = ?", (old_id,))


def _has_shared_views(conn) -> bool:
    """Recognize operator-provisioned v1 storage; never adopt by table name alone."""
    schema = conn.execute(
        "SELECT sql FROM main.sqlite_master WHERE (type='table' AND name='views') "
        "OR (type='trigger' AND name='views_updated_at') ORDER BY type"
    ).fetchall()
    expected = _pkg().table_ddl("views", ["name:text!", "tbl:ref!", "definition:json!"])
    if [re.sub(r"\s+", " ", r["sql"]).strip() for r in schema] != [
        re.sub(r"\s+", " ", sql).strip() for sql in expected
    ]:
        return False
    entry = conn.execute(
        "SELECT kind,display FROM catalog_tables WHERE id='views' AND deleted_at IS NULL"
    ).fetchone()
    props = conn.execute(
        "SELECT * FROM catalog_properties WHERE tbl='views' AND deleted_at IS NULL"
    ).fetchall()
    required = {"name": "text", "tbl": "ref", "definition": "json"}
    if not entry or dict(entry) != {"kind": "table", "display": "name"} or len(props) != 3:
        return False
    by_col = {p["col"]: p for p in props}
    if set(by_col) != set(required) or any(
        p["id"] != f"views.{col}" or p["type"] != required[col] or p["required"] != 1
        for col, p in by_col.items()
    ):
        return False
    return (
        by_col["tbl"]["ref_table"] == "catalog_tables"
        and by_col["definition"]["source"] == "life-core"
        and by_col["definition"]["source_ref"] == "saved-views/v1"
    )


def _has_view_defaults(conn, table="view_defaults", marker="view-defaults/v1") -> bool:
    """Recognize the canonical optional preference store, without adopting collisions."""
    schema = conn.execute(
        "SELECT sql FROM main.sqlite_master WHERE (type='table' AND name=?) "
        "OR (type='trigger' AND name=?) ORDER BY type",
        (table, table + "_updated_at"),
    ).fetchall()
    expected = _pkg().table_ddl(table, ["tbl:ref!", "view_id:ref"])
    if [re.sub(r"\s+", " ", row["sql"]).strip() for row in schema] != [
        re.sub(r"\s+", " ", sql).strip() for sql in expected
    ]:
        return False
    entry = conn.execute(
        "SELECT kind,display FROM catalog_tables WHERE id=? AND deleted_at IS NULL", (table,)
    ).fetchone()
    props = conn.execute(
        "SELECT * FROM catalog_properties WHERE tbl=? AND deleted_at IS NULL", (table,)
    ).fetchall()
    if not entry or dict(entry) != {"kind": "table", "display": "tbl"} or len(props) != 2:
        return False
    by_col = {p["col"]: p for p in props}
    if set(by_col) != {"tbl", "view_id"}:
        return False
    return all(
        p["id"] == f"{table}.{col}" and p["type"] == "ref" and p["ref_table"] == target
        for col, target in (("tbl", "catalog_tables"), ("view_id", "views"))
        for p in [by_col[col]]
    ) and (
        by_col["tbl"]["required"] == 1
        and by_col["view_id"]["source"] == "life-core"
        and by_col["view_id"]["source_ref"] == marker
    )


def _rename_view_default(
    conn, old: str, new: str, table="view_defaults", prefix="default:v1:", marker="view-defaults/v1"
) -> None:
    if not _has_view_defaults(conn, table, marker):
        return
    old_id, new_id = (prefix + value.encode("ascii").hex() for value in (old, new))
    rows = conn.execute(f"SELECT * FROM {qi(table)} WHERE tbl=? OR id=?", (old, old_id)).fetchall()
    if not rows:
        return
    if len(rows) != 1 or rows[0]["id"] != old_id or rows[0]["tbl"] != old:
        raise ValueError("Stored view default is invalid; rename was not applied")
    row = dict(rows[0])
    stamp = conn.execute(
        f"SELECT max({_pkg().NOW}, strftime('%Y-%m-%dT%H:%M:%fZ',?,'+0.001 seconds'))",
        (row["updated_at"],),
    ).fetchone()[0]
    if stamp is None:
        raise ValueError("Stored view default revision is invalid")
    row.update(id=new_id, tbl=new, updated_at=stamp, hub_at=None)
    cols = list(row)
    conn.execute(
        f"INSERT INTO {qi(table)} ({', '.join(qi(c) for c in cols)}) "
        f"VALUES ({', '.join('?' for _ in cols)})",
        list(row.values()),
    )
    conn.execute(
        f"UPDATE {qi(table)} SET deleted_at=?,updated_at=? WHERE id=?", (stamp, stamp, old_id)
    )


def rename_refs(conn, old: str, new: str) -> None:
    """Point every catalog, provenance and history reference at the new name.
    Runs inside the rename's transaction; the caller has already renamed the
    table itself."""
    # ponytail: rule/options SQL is rewritten by word boundary; the DDL
    # recompile in `write` rejects the rename if anything still fails to compile
    word = re.compile(rf"\b{re.escape(old)}\b")
    for p in conn.execute(
        "SELECT id, col FROM catalog_properties WHERE tbl = ? AND deleted_at IS NULL", (old,)
    ).fetchall():
        _rekey(conn, "catalog_properties", p["id"], f"{new}.{p['col']}", tbl=new)
    conn.execute(
        "UPDATE catalog_properties SET ref_table = ? WHERE ref_table = ? AND deleted_at IS NULL",
        (new, old),
    )
    for p in conn.execute(
        "SELECT id, options_sql FROM catalog_properties WHERE options_sql IS NOT NULL AND deleted_at IS NULL"
    ).fetchall():
        conn.execute(
            "UPDATE catalog_properties SET options_sql = ? WHERE id = ?",
            (word.sub(new, p["options_sql"]), p["id"]),
        )
    if conn.execute("SELECT 1 FROM catalog_tables WHERE id = ?", (old,)).fetchone():
        _rekey(conn, "catalog_tables", old, new)
    from .sidebar_pins import rename as rename_sidebar_pins

    rename_sidebar_pins(conn, old, new)
    if _has_shared_views(conn):
        # Definitions contain layout/query state, never a repeated table name.
        # Keep tombstones pointed at the renamed target for later restoration.
        # catalog.write validates and journals this with the rest of the rename.
        # A synced revision can be ahead of this device's clock. The timestamp
        # trigger alone could lower it, causing LWW to discard the rename.
        conn.execute(
            f"UPDATE views SET tbl = ?, updated_at = max({_pkg().NOW}, "
            "strftime('%Y-%m-%dT%H:%M:%fZ',updated_at,'+0.001 seconds')) WHERE tbl = ?",
            (new, old),
        )
    _rename_view_default(conn, old, new)
    _rename_view_default(
        conn, old, new, "related_view_defaults", "related:v1:", "related-view-defaults/v1"
    )
    conn.execute(
        "UPDATE catalog_rules SET tbl = ? WHERE tbl = ? AND deleted_at IS NULL", (new, old)
    )
    for r in conn.execute(
        "SELECT id, sql FROM catalog_rules WHERE sql IS NOT NULL AND deleted_at IS NULL"
    ).fetchall():
        conn.execute(
            "UPDATE catalog_rules SET sql = ? WHERE id = ?", (word.sub(new, r["sql"]), r["id"])
        )
    if _table_exists(conn, "provenance"):
        # derivation ids embed the table (`<to_kind>:<to_ref>:<field>`); edges do not
        for r in conn.execute(
            "SELECT id FROM provenance WHERE to_kind = ? AND rel = 'derived_from' "
            "AND id LIKE ? AND deleted_at IS NULL",
            (old, f"{old}:%"),
        ).fetchall():
            _rekey(conn, "provenance", r["id"], new + r["id"][len(old) :], to_kind=new)
        conn.execute(
            "UPDATE provenance SET to_kind = ? WHERE to_kind = ? AND deleted_at IS NULL", (new, old)
        )
    if _table_exists(conn, "history"):
        conn.execute("UPDATE history SET tbl = ? WHERE tbl = ?", (new, old))


# --- invariants --------------------------------------------------------------

# Mirror core/src/rule-sql.ts; shared rule-sql-cases.json is the contract.
# This conservative text screen is not a parser or a transitive purity proof.
_RULE_FUNCTIONS = (
    "random|randomblob|date|time|datetime|julianday|unixepoch|strftime|timediff|"
    "changes|total_changes|last_insert_rowid|sqlite_version|sqlite_source_id"
)
_RULE_TRIVIA = r"(?:\s|/\*[\s\S]*?\*/|--[^\n]*(?:\n|$))*"
FORBIDDEN = re.compile(
    rf"\b(?:{_RULE_FUNCTIONS})[\"'`\]]?{_RULE_TRIVIA}\("
    r"|\bcurrent_(?:timestamp|date|time)\b|localtime|'now'",
    re.IGNORECASE,
)


def check_rule_sql(sql: str) -> None:
    if not sql or not re.match(r"^\s*SELECT\b", sql, re.IGNORECASE):
        raise ValueError("rule sql must be a single SELECT")
    if FORBIDDEN.search(sql):
        raise ValueError(
            "rule sql may not use clock, date/time, randomness or connection-state "
            "functions (compare or slice (SELECT ts FROM now) directly)"
        )


def _first(sql: str) -> str:
    return sql.lstrip().split(None, 1)[0].upper() if sql.strip() else ""


def _uses(sql: str, name: str) -> bool:
    return re.search(rf"\b{name}\b", sql, re.IGNORECASE) is not None


def _with_context(conn, sql, changed_ids, now, tbl):
    """Create the temp tables a rule may reference; return a cleanup fn."""
    made = []
    # every temp DDL/DML below is schema-qualified `temp.`: unqualified names
    # resolve temp-first but fall through to main, so an unqualified DROP would
    # destroy a USER table named `now`/`changed`/`before` on the first run
    if _uses(sql, "now"):
        conn.execute("CREATE TEMP TABLE IF NOT EXISTS temp.now (ts TEXT)")
        conn.execute("DELETE FROM temp.now")
        conn.execute(
            "INSERT INTO temp.now (ts) VALUES (?)",
            (now or conn.execute(f"SELECT {_pkg().NOW}").fetchone()[0],),
        )
        made.append("now")
    if tbl and (_uses(sql, "changed") or _uses(sql, "before")):
        ids = list(changed_ids or [])
        ph = ", ".join("?" for _ in ids) or "NULL"
        conn.execute("DROP TABLE IF EXISTS temp.changed")
        predicate = "" if changed_ids is None else f" WHERE id IN ({ph})"
        conn.execute(
            f"CREATE TEMP TABLE temp.changed AS SELECT * FROM main.{qi(tbl)}{predicate}",
            ids,
        )
        conn.execute("DROP TABLE IF EXISTS temp.before")
        if _table_exists_temp(conn, f"_before_{tbl}"):
            # explicit column list, not `*`: _before_{tbl} carries an extra
            # _rowid bookkeeping column that would break shape-sensitive
            # queries (EXCEPT/UNION) against `changed`, which has tbl's shape
            cols = ", ".join(
                qi(r[1]) for r in conn.execute(f"PRAGMA main.table_info({qi(tbl)})").fetchall()
            )
            conn.execute(
                f"CREATE TEMP TABLE temp.before AS SELECT {cols} "
                f"FROM temp.{qi(f'_before_{tbl}')} WHERE id IN ({ph})",
                ids,
            )
        else:
            conn.execute(f"CREATE TEMP TABLE temp.before AS SELECT * FROM main.{qi(tbl)} WHERE 0")
        made += ["changed", "before"]

    def cleanup():
        for t in made:
            conn.execute(f"DROP TABLE IF EXISTS temp.{t}")

    return cleanup


def _table_exists_temp(conn, name) -> bool:
    return (
        conn.execute("SELECT 1 FROM sqlite_temp_master WHERE name = ?", (name,)).fetchone()
        is not None
    )


def compile_sql(conn: sqlite3.Connection, sql: str, tbl: str | None = None) -> None:
    def cleanup():
        pass

    try:
        cleanup = _with_context(conn, sql, [], None, tbl)
        conn.execute(f"SELECT * FROM ({sql}) LIMIT 0")
    except sqlite3.Error as e:
        raise ValueError(f"sql does not compile: {e}") from e
    finally:
        cleanup()


def run_invariant(conn, rule: dict, changed_ids=None, now=None) -> list[dict]:
    # Existing/synced catalog rows also pass the boundary, not only set_rule.
    check_rule_sql(rule["sql"])

    def cleanup():
        pass

    try:
        cleanup = _with_context(conn, rule["sql"], changed_ids, now, rule.get("tbl"))
        return [dict(r) for r in conn.execute(rule["sql"]).fetchall()]
    finally:
        cleanup()


# --- derivations & provenance -------------------------------------------------


def canonical_text(expr: str, type_: str | None = None) -> str:
    """How a value is rendered for hashing, typed by the catalog and identical
    for a stored column and a bound value (worker/src/validate.js
    `canonicalSql` mirrors it). The hub's D1 binds every number as a REAL, so a
    stored INTEGER 1999 comes back to it as 1999.0: a `number` is always REAL
    text (4 -> '4.0'), every other type renders an integral REAL as an integer
    ('1999')."""
    if type_ == "number":
        return f"CAST(CAST({expr} AS REAL) AS TEXT)"
    return (
        f"CASE WHEN typeof({expr}) = 'real' AND {expr} = CAST({expr} AS INTEGER) "
        f"THEN CAST(CAST({expr} AS INTEGER) AS TEXT) ELSE CAST({expr} AS TEXT) END"
    )


def legacy_text(expr: str, type_: str | None = None) -> str:
    """The rendering hubs hashed before the typed one: every bound number as
    REAL text ('1999.0'). Proofs in that form are still accepted, so they stay
    fresh without re-fetching their providers."""
    if type_ == "number":
        return canonical_text(expr, type_)
    return (
        f"CASE WHEN typeof({expr}) IN ('integer', 'real') "
        f"THEN CAST(CAST({expr} AS REAL) AS TEXT) ELSE CAST({expr} AS TEXT) END"
    )


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def _types(conn, tbl: str) -> dict:
    return {p["col"]: p.get("type") for p in properties(conn, tbl)}


def _inputs_hashes(conn, tbl: str, row_id: str, inputs: list[str]) -> tuple[str, str] | None:
    """(canonical, legacy) hashes of a stored row's inputs; None when the row is
    gone (hard-deleted out from under its provenance)."""
    type_of = _types(conn, tbl)
    texts = [
        ", ".join(render(qi(c), type_of.get(c)) for c in inputs) or "NULL"
        for render in (canonical_text, legacy_text)
    ]
    row = conn.execute(
        f"SELECT json_array({texts[0]}), json_array({texts[1]}) FROM {qi(tbl)} WHERE id = ?",
        (row_id,),
    ).fetchone()
    return (_sha(row[0]), _sha(row[1])) if row else None


def inputs_hash(conn, tbl: str, row_id: str, inputs: list[str]) -> str | None:
    """Hash the inputs as SQLite renders them, so Python and the hub agree byte
    for byte. None when the row is gone."""
    hashes = _inputs_hashes(conn, tbl, row_id, inputs)
    return hashes[0] if hashes else None


def value_hash(conn, tbl: str, row_id: str, col: str) -> str | None:
    text = canonical_text(qi(col), _types(conn, tbl).get(col))
    row = conn.execute(
        f"SELECT coalesce({text}, '') FROM {qi(tbl)} WHERE id = ?", (row_id,)
    ).fetchone()
    return _sha(row[0]) if row else None


def stale(conn) -> list[Violation]:
    out = []
    for p in properties(conn):
        if not p.get("derived_by") or not _table_exists(conn, p["tbl"]):
            continue
        rows = conn.execute(
            "SELECT pr.to_ref AS row_id, pr.inputs_hash FROM provenance pr WHERE pr.to_kind = ? AND pr.field = ? AND pr.deleted_at IS NULL",
            (p["tbl"], p["col"]),
        ).fetchall()
        for r in rows:
            h = _inputs_hashes(conn, p["tbl"], r["row_id"], p.get("inputs") or [])
            if h is None:
                out.append(
                    Violation(
                        p["tbl"],
                        r["row_id"],
                        p["col"],
                        "orphan",
                        "provenance exists for a row that no longer exists",
                    )
                )
            elif r["inputs_hash"] not in h:
                out.append(
                    Violation(
                        p["tbl"],
                        r["row_id"],
                        p["col"],
                        "stale",
                        f"{p['col']} was derived from inputs that have since changed.",
                    )
                )
    return out


def underived(conn) -> list[Violation]:
    out = []
    for p in properties(conn):
        if not p.get("derived_by") or not _table_exists(conn, p["tbl"]):
            continue
        rows = conn.execute(
            f"SELECT t.id FROM {qi(p['tbl'])} t WHERE t.deleted_at IS NULL AND NOT EXISTS "
            "(SELECT 1 FROM provenance pr WHERE pr.to_kind = ? AND pr.field = ? AND pr.to_ref = t.id AND pr.deleted_at IS NULL)",
            (p["tbl"], p["col"]),
        ).fetchall()
        for r in rows:
            out.append(
                Violation(
                    p["tbl"], r["id"], p["col"], "underived", f"{p['col']} has not been derived."
                )
            )
    return out


# --- check -------------------------------------------------------------------


def check(path: Path, as_of: str | None = None) -> list[dict]:
    """Whole-estate, read-only report: every property violation (whole-table
    state, not just changed rows) and every invariant regardless of enforce."""
    pkg = _pkg()
    out: list[Violation] = []
    with pkg.connect(path) as conn:
        for t in cataloged_tables(conn):
            if not _table_exists(conn, t):
                continue
            props = properties(conn, t)
            for r in conn.execute(f"SELECT * FROM {qi(t)} WHERE deleted_at IS NULL").fetchall():
                out += validate_row(
                    props,
                    dict(r),
                    dict(r),
                    in_derive={p["col"] for p in props},
                    ref_ok=_ref_ok(conn),
                    extra_options=_extra_options(conn),
                )
        for rule in rules(conn, kind="invariant"):
            try:
                hits = run_invariant(conn, rule, changed_ids=None, now=as_of)
            except (sqlite3.Error, ValueError, TypeError) as e:
                out.append(
                    Violation(
                        rule.get("tbl") or "estate",
                        None,
                        rule.get("col"),
                        "rule-error",
                        f"{rule['id']} failed to run: {e}",
                    )
                )
                continue
            for h in hits:
                out.append(
                    Violation(
                        rule.get("tbl") or "estate",
                        h.get("id"),
                        rule.get("col"),
                        rule["id"],
                        rule["text"],
                    )
                )
        out += stale(conn) + underived(conn)
    return [v.as_dict() for v in out]


def history_trail(events, old, new) -> bool:
    """Linear Euler-trail check; timestamps and random IDs imply no ordering."""
    degree, neighbors = {}, {}
    for event in events:
        a, b = event["old"], event["new"]
        degree[a] = degree.get(a, 0) + 1
        degree[b] = degree.get(b, 0) - 1
        neighbors.setdefault(a, set()).add(b)
        neighbors.setdefault(b, set()).add(a)
    if old not in neighbors or new not in neighbors:
        return False
    if any(n != int(v == old) - int(v == new) for v, n in degree.items()):
        return False
    seen, todo = set(), [old]
    while todo:
        v = todo.pop()
        if v not in seen:
            seen.add(v)
            todo.extend(neighbors[v] - seen)
    return len(seen) == len(neighbors)


_HISTORY_SEARCH_LIMIT = 10_000


class _HistoryAmbiguity(Exception):
    """The bounded matcher could neither prove nor disprove a history match."""


def _history_segments(events, transitions):
    """Match ordered edits to disjoint paths, revisiting ambiguous earlier choices."""
    if len(transitions) == 1 and history_trail(events, *transitions[0]):
        return True
    edges = {}
    for event in events:
        edges.setdefault(event["old"], []).append(event)
    start = transitions[0][0]
    todo = [(0, start, frozenset(), frozenset({start}))]
    # Bound generated states; exhausting the search is not proof of divergence.
    budget = _HISTORY_SEARCH_LIMIT
    while todo:
        step, value, used, visited = todo.pop()
        target = transitions[step][1]
        if value == target:
            if step + 1 == len(transitions):
                return True
            if not budget:
                raise _HistoryAmbiguity
            start = transitions[step + 1][0]
            todo.append((step + 1, start, used, frozenset({start})))
            budget -= 1
            continue
        # Prefer direct events before considering a coalesced path.
        for event in sorted(edges.get(value, []), key=lambda e: e["new"] == target):
            if event["id"] not in used and event["new"] not in visited:
                if not budget:
                    raise _HistoryAmbiguity
                todo.append((step, event["new"], used | {event["id"]}, visited | {event["new"]}))
                budget -= 1
    return False


def push_history(conn, table, row, before, events, now, batch=None):
    """Import original facts by ID and log only the unexplained hub transition."""
    if table in CATALOG_TABLES:
        if events:
            raise ValueError("history cannot describe engine tables")
        return
    after = dict(conn.execute(f"SELECT * FROM {qi(table)} WHERE id=?", (row["id"],)).fetchone())
    changed = [c for c in after if c not in HISTORY_SKIP and before and before[c] != after[c]]
    if not changed and not events:
        return
    if not _table_exists(conn, "history"):
        for ddl in _pkg().table_ddl("history", CATALOG_TABLES["history"]):
            conn.execute(ddl)
            conn.execute("INSERT INTO _schema_log (ddl) VALUES (?)", (ddl,))
    fields = ("id", "tbl", "row_id", "col", "old", "new", "origin", "created_at", "updated_at")
    unseen, seen = [], {}
    for event in events:
        if (
            any(c not in event for c in fields)
            or not event["id"]
            or event["tbl"] != table
            or event["row_id"] != row["id"]
            or event["col"] not in after
            or event["col"] in HISTORY_SKIP
            or any(event[c] is not None and not isinstance(event[c], str) for c in ("old", "new"))
            or not valid_edit_timestamp(event["created_at"])
            or not valid_edit_timestamp(event["updated_at"])
        ):
            raise ValueError("invalid attached history event")
        existing = conn.execute("SELECT * FROM history WHERE id=?", (event["id"],)).fetchone()
        previous = dict(existing) if existing else seen.get(event["id"])
        if previous:
            if any(previous[c] != event[c] for c in fields):
                raise ValueError("history ID reused for a different event")
        else:
            unseen.append(event)
            seen[event["id"]] = event
    available = unseen if batch is None else batch["events"]
    for col in changed:
        old, new = [
            conn.execute("SELECT CAST(? AS TEXT)", (r[col],)).fetchone()[0] for r in (before, after)
        ]
        related = [e for e in available if e.get("row_id") == row["id"] and e.get("col") == col]
        key = (row["id"], col)
        transitions = (batch["matched"].get(key, []) if batch is not None else []) + [(old, new)]
        if _history_segments(related, transitions):
            if batch is not None:
                batch["matched"][key] = transitions
            continue
        conn.execute(
            "INSERT INTO history (tbl,row_id,col,old,new,origin,created_at,updated_at,hub_at) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (
                table,
                row["id"],
                col,
                old,
                new,
                "hub:reconcile" if related else "hub",
                row["updated_at"],
                now,
                now,
            ),
        )
    for event in unseen:
        cols = list(fields) + ["hub_at"]
        conn.execute(
            f"INSERT INTO history ({','.join(qi(c) for c in cols)}) VALUES ({','.join('?' for _ in cols)})",
            [event[c] for c in fields] + [now],
        )


def valid_edit_timestamp(value) -> bool:
    """Protocol metadata, even for a table with no catalog."""
    if not isinstance(value, str) or not re.fullmatch(
        r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z", value
    ):
        return False
    try:
        datetime.fromisoformat(value)
        return True
    except ValueError:
        return False


def validate_push(
    conn: sqlite3.Connection, table: str, rows: list[dict], *, before_rows=None, after_rows=None
) -> tuple[list[dict], list[dict]]:
    """Split pushed rows into (accepted, rejected). Property checks plus provenance
    for derived columns. Pure over the hub's own db; never runs a derivation."""
    props = properties(conn, table) if table not in ENGINE_TABLES else []
    accepted, rejected = [], []
    for row in rows:
        existing = (
            conn.execute(f"SELECT * FROM {qi(table)} WHERE id = ?", (row["id"],)).fetchone()
            if _table_exists(conn, table)
            else None
        )
        before = (
            before_rows[row["id"]]
            if before_rows is not None
            else (dict(existing) if existing else None)
        )
        # A push carries only the columns it writes: validate the row as it
        # will BE (stored columns plus this write), so a partial update need
        # not echo required columns the stored row already has.
        merged = (
            after_rows[row["id"]]
            if after_rows is not None
            else ({**before, **row} if before else row)
        )
        if merged.get("deleted_at"):
            accepted.append(row)
            continue
        derived = {p["col"] for p in props if p.get("derived_by")}
        viol = validate_row(
            props,
            before,
            merged,
            in_derive=derived,
            ref_ok=_ref_ok(conn),
            extra_options=_extra_options(conn),
            touched=set(row) if before else None,
        )
        type_of = {q["col"]: q.get("type") for q in props}
        for p in props:
            if not p.get("derived_by"):
                continue
            col = p["col"]
            changed = (
                (merged.get(col) is not None)
                if before is None
                else not _same(merged.get(col), before.get(col))
            )
            if not changed:
                continue
            prov = conn.execute(
                "SELECT inputs_hash, value_hash FROM provenance WHERE id = ? AND deleted_at IS NULL",
                (f"{table}:{row['id']}:{col}",),
            ).fetchone()
            # bound values, typed like the stored columns; either rendering proves it
            inputs = p.get("inputs") or []
            cells = [*inputs, col]
            arrays = [
                f"json_array({', '.join(render(f'a{i}', type_of.get(c)) for i, c in enumerate(inputs)) or 'NULL'})"
                for render in (canonical_text, legacy_text)
            ]
            values = [
                f"coalesce({render(f'a{len(inputs)}', p.get('type'))}, '')"
                for render in (canonical_text, legacy_text)
            ]
            source = ", ".join(f"? AS a{i}" for i in range(len(cells)))
            texts = conn.execute(
                f"SELECT {', '.join(arrays + values)} FROM (SELECT {source})",
                [merged.get(c) for c in cells],
            ).fetchone()
            ok = (
                prov
                and prov["inputs_hash"] in {_sha(texts[0]), _sha(texts[1])}
                and prov["value_hash"] in {_sha(texts[2]), _sha(texts[3])}
            )
            if not ok:
                viol.append(
                    Violation(
                        table,
                        row["id"],
                        col,
                        "provenance",
                        f"{col} changed without a matching provenance record.",
                    )
                )
        if viol:
            rejected += [
                {
                    "id": row["id"],
                    **{k: v for k, v in x.as_dict().items() if k in ("col", "rule", "message")},
                }
                for x in viol
            ]
        else:
            accepted.append(row)
    return accepted, rejected


# --- audit -------------------------------------------------------------------


def audit(path: Path, rule_id: str | None = None, commands: dict | None = None) -> list[dict]:
    out = []
    with _pkg().connect(path) as conn:
        todo = [r for r in rules(conn, kind="audit") if not rule_id or r["id"] == rule_id]
    for r in todo:
        cmd = (commands or {}).get(r.get("cmd") or "")
        if not cmd:
            raise RuntimeError(
                f"no command configured for audit {r['id']!r} (config.json: commands)"
            )
        res = subprocess.run(
            cmd,
            shell=True,
            input=json.dumps({"rule": r["id"], "tbl": r.get("tbl")}),
            capture_output=True,
            text=True,
            check=False,
        )
        if res.returncode != 0:
            raise RuntimeError(f"audit {r['id']} failed: {res.stderr.strip()[:500]}")
        for f in json.loads(res.stdout or "[]"):
            out.append(
                {
                    "tbl": f.get("tbl", r.get("tbl")),
                    "row_id": f.get("row_id"),
                    "col": f.get("col"),
                    "rule": r["id"],
                    "message": f.get("message", r["text"]),
                }
            )
    return out


# --- infer -------------------------------------------------------------------

SYNC_COLS = {"id", "created_at", "updated_at", "deleted_at", "hub_at"}


def _is_stub_property(p: dict) -> bool:
    """True for a bare `text` property carrying no refinement beyond what
    `create_table` seeds by default (col:type with no `!`/options/etc) —
    `infer` should still be free to propose a tighter type for these."""
    return p.get("type") in (None, "text") and not any(
        p.get(k)
        for k in (
            "required",
            "options",
            "derived_by",
            "pattern",
            "ref_table",
            "description",
            "immutable",
            "deprecated",
            "default_value",
        )
    )


def infer(path: Path, tbl: str | None = None, min_rows: int = 20) -> list[dict]:
    pkg = _pkg()
    out = []
    with pkg.connect(path) as conn:
        all_tables = [
            r[0]
            for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
            if not r[0].startswith(("_", "sqlite_")) and r[0] not in ENGINE_TABLES
        ]
        tables = [tbl] if tbl else all_tables
        id_sets = {}
        for t in tables:
            n = conn.execute(f"SELECT count(*) FROM {qi(t)} WHERE deleted_at IS NULL").fetchone()[0]
            if n < min_rows:
                continue
            known = {p["col"] for p in properties(conn, t) if not _is_stub_property(p)}
            cols = [r[1] for r in conn.execute(f"PRAGMA table_info({qi(t)})").fetchall()]
            for c in cols:
                if c in SYNC_COLS or c in known:
                    continue
                vals = [
                    r[0]
                    for r in conn.execute(
                        f"SELECT {qi(c)} FROM {qi(t)} WHERE deleted_at IS NULL "
                        f"AND {qi(c)} IS NOT NULL AND {qi(c)} != ''"
                    ).fetchall()
                ]
                prop = {"tbl": t, "col": c, "type": "text"}
                if len(vals) == n:
                    prop["required"] = 1
                if not vals:
                    out.append(prop)
                    continue
                strs = [v for v in vals if isinstance(v, str)]
                lists = [_as_list(v) for v in strs]
                if strs and all(l is not None for l in lists):
                    flat = sorted({x for l in lists for x in l})
                    if len(flat) <= 30:
                        prop.update(type="multi_select", options=[{"v": x} for x in flat])
                        out.append(prop)
                        continue
                if strs and all(DATE_RE.match(v) for v in strs):
                    prop["type"] = "date"
                elif strs and all(v.startswith(("http://", "https://")) for v in strs):
                    prop.update(
                        type="url",
                        pattern="^https://.+"
                        if all(v.startswith("https://") for v in strs)
                        else "^https?://.+",
                    )
                else:
                    ref = _ref_target(conn, all_tables, vals, id_sets, exclude=t)
                    if ref:
                        prop.update(type="ref", ref_table=ref)
                    else:
                        distinct = sorted(set(map(str, vals)))
                        if len(distinct) <= 20 and len(distinct) / len(vals) < 0.5:
                            prop.update(type="select", options=[{"v": v} for v in distinct])
                out.append(prop)
    return out


def _ref_target(conn, tables, vals, id_sets, exclude):
    fits = []
    for t in sorted(tables):
        if t == exclude:
            continue
        if t not in id_sets:
            id_sets[t] = {r[0] for r in conn.execute(f"SELECT id FROM {qi(t)}").fetchall()}
        if id_sets[t] and all(v in id_sets[t] for v in vals):
            fits.append(t)
    return min(fits, key=lambda t: (len(id_sets[t]), t), default=None)


# --- doc ---------------------------------------------------------------------


def _cell(s: str) -> str:
    """Escape a value for a markdown table cell: pipes break columns, newlines break rows."""
    return str(s).replace("|", "\\|").replace("\n", " ")


def _constraint(p: dict) -> str:
    parts = []
    if p.get("options"):
        parts.append(
            ", ".join(f"`{o['v']}`" + (f" ({o['d']})" if o.get("d") else "") for o in p["options"])
        )
    if p.get("options_sql"):
        parts.append(f"plus `{p['options_sql']}`")
    if p.get("min_items") or p.get("max_items"):
        parts.append(f"{p.get('min_items') or 0}..{p.get('max_items') or '∞'} items")
    if p.get("pattern"):
        parts.append(f"matches `{p['pattern']}`")
    if p.get("ref_table"):
        parts.append(f"→ {p['ref_table']}")
    if p.get("derived_by"):
        parts.append(f"derived by `{p['derived_by']}` from {', '.join(p.get('inputs') or [])}")
    if p.get("default_value") is not None:
        parts.append(f"default `{p['default_value']}`")
    if p.get("immutable"):
        parts.append("immutable")
    if p.get("deprecated"):
        parts.append("**deprecated**")
    return "; ".join(parts)


def doc(conn: sqlite3.Connection, tbl: str | None = None) -> str:
    lines = ["# Estate map", "", "_Generated by `soma doc`. Do not edit by hand._", ""]
    described = (
        {
            r["id"]: dict(r)
            for r in conn.execute(
                "SELECT * FROM catalog_tables WHERE deleted_at IS NULL ORDER BY id"
            ).fetchall()
        }
        if has_catalog(conn)
        else {}
    )
    names = sorted(set(described) | set(cataloged_tables(conn)))
    for t in names:
        if tbl and t != tbl:
            continue
        meta = described.get(t, {})
        lines += [f"### {t}", ""]
        if meta.get("purpose"):
            lines += [meta["purpose"], ""]
        for k, label in (
            ("id_semantics", "Row id"),
            ("provenance", "From"),
            ("owner", "Written by"),
        ):
            if meta.get(k):
                lines.append(f"- **{label}:** {meta[k]}")
        if meta.get("consumers"):
            lines.append(f"- **Read by:** {', '.join(json.loads(meta['consumers']))}")
        if meta.get("display"):
            lines.append(f"- **Row title:** `{meta['display']}`")
        if meta.get("description"):
            lines += ["", meta["description"]]
        props = properties(conn, t)
        if props:
            lines += [
                "",
                "| col | type | required | constraint | description |",
                "|---|---|---|---|---|",
            ]
            for p in props:
                lines.append(
                    f"| {_cell(p['col'])} | {_cell(p.get('type', 'text'))} | "
                    f"{'yes' if p.get('required') else ''} | {_cell(_constraint(p))} | "
                    f"{_cell(p.get('description') or '')} |"
                )
        trules = [r for r in rules(conn, tbl=t) if r.get("tbl") == t]
        if trules:
            lines += ["", "**Rules**", ""]
            for r in trules:
                flag = " (enforced)" if r.get("enforce") else ""
                lines.append(f"- `{r['kind']}` **{r['id']}**{flag}: {r['text']}")
                if r.get("sql"):
                    lines += ["", "  ```sql", f"  {r['sql']}", "  ```", ""]
        lines.append("")
    estate = [r for r in rules(conn) if r.get("scope") == "estate"]
    if estate and not tbl:
        lines += ["## Estate rules", ""]
        for r in estate:
            lines.append(f"- `{r['kind']}` **{r['id']}**: {r['text']}")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def compile_all(conn: sqlite3.Connection) -> list[str]:
    """Compile every invariant. Returns the ids that fail."""
    bad = []
    # ponytail: catalog tables come up one CREATE TABLE at a time during
    # ensure_catalog's own bootstrap DDL, so a sibling catalog table (e.g.
    # catalog_rules) may not exist yet even though catalog_properties does.
    if _table_exists(conn, "catalog_rules"):
        for r in rules(conn, kind="invariant"):
            try:
                compile_sql(conn, r["sql"], r.get("tbl"))
            except ValueError:
                bad.append(r["id"])
    return bad
