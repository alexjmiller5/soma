import io
import json
import sqlite3
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import ClassVar

import pytest

from soma import (
    DEFAULT_HUB_URL,
    NOW,
    HttpHub,
    LocalHub,
    auth_headers,
    catalog,
    connect,
    create_table,
    db_changed,
    db_version,
    dump_sql,
    execute_sql,
    init,
    insert_rows,
    load_config,
    main,
    rename_table,
    resolve_data_dir,
    sync,
    watch,
)


@pytest.fixture()
def db(tmp_path):
    return init(tmp_path / "soma.db")


@pytest.fixture()
def hub(tmp_path):
    return LocalHub(tmp_path / "hub.db")


def _mk_people(path, names):
    create_table(path, "people", ["name:text"])
    insert_rows(path, "people", [{"name": n} for n in names])


# --- data dir & config -------------------------------------------------------


def test_resolve_data_dir_env_override(monkeypatch, tmp_path):
    monkeypatch.setenv("SOMA_DATA_DIR", str(tmp_path / "custom"))
    assert resolve_data_dir() == tmp_path / "custom"


def test_resolve_data_dir_xdg(monkeypatch, tmp_path):
    monkeypatch.delenv("SOMA_DATA_DIR", raising=False)
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "xdg"))
    assert resolve_data_dir() == tmp_path / "xdg" / "soma"


def test_config_defaults_to_hosted_hub_without_a_config_file(monkeypatch, tmp_path):
    monkeypatch.setenv("SOMA_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SOMA_HUB_TOKEN", "tok")
    cfg = load_config()
    assert cfg["hub_url"] == DEFAULT_HUB_URL
    assert cfg["token"] == "tok"


def test_config_file_overrides_url_and_token(monkeypatch, tmp_path):
    monkeypatch.setenv("SOMA_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("SOMA_HUB_TOKEN", raising=False)
    (tmp_path / "config.json").write_text(
        json.dumps({"hub_url": "https://self.hosted", "token": "abc"})
    )
    cfg = load_config()
    assert cfg["hub_url"] == "https://self.hosted"
    assert cfg["token"] == "abc"


def test_config_token_cmd_is_optional_shell_indirection(monkeypatch, tmp_path):
    monkeypatch.setenv("SOMA_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("SOMA_HUB_TOKEN", raising=False)
    (tmp_path / "config.json").write_text(json.dumps({"token_cmd": "printf secret"}))
    assert load_config()["token"] == "secret"


def test_env_token_wins_over_config(monkeypatch, tmp_path):
    monkeypatch.setenv("SOMA_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SOMA_HUB_TOKEN", "fromenv")
    (tmp_path / "config.json").write_text(json.dumps({"token": "fromfile"}))
    assert load_config()["token"] == "fromenv"


def test_auth_headers_are_generic_bearer_plus_optional_extras():
    h = auth_headers({"token": "abc", "headers": {"CF-Access-Client-Id": "x"}})
    assert h["Authorization"] == "Bearer abc"
    assert h["CF-Access-Client-Id"] == "x"


# --- local database ----------------------------------------------------------


def test_init_creates_plumbing_and_is_idempotent(tmp_path):
    path = tmp_path / "nested" / "soma.db"
    init(path)
    init(path)
    conn = sqlite3.connect(path)
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"_schema_log", "_sync_state"} <= tables
    assert conn.execute("PRAGMA journal_mode").fetchone()[0] == "wal"


def test_init_upgrades_an_existing_estate_but_leaves_a_fresh_db_uncataloged(db):
    assert not catalog.has_catalog(connect(db))
    _mk_people(db, ["Ada"])
    execute_sql(db, "DROP TABLE history")
    execute_sql(db, "UPDATE catalog_tables SET deleted_at = updated_at WHERE id = 'history'")
    init(db)
    names = {
        r["name"] for r in execute_sql(db, "SELECT name FROM sqlite_master WHERE type='table'")
    }
    assert "history" in names
    assert execute_sql(
        db, "SELECT purpose FROM catalog_tables WHERE id = 'history' AND deleted_at IS NULL"
    )


def test_sql_select_returns_rows_as_dicts(db):
    assert execute_sql(db, "SELECT 1 AS one, 'a' AS letter") == [{"one": 1, "letter": "a"}]


def test_ddl_is_recorded_in_schema_log(db):
    execute_sql(db, "CREATE TABLE pets (id TEXT PRIMARY KEY, name TEXT)")
    assert execute_sql(db, "SELECT ddl FROM _schema_log") == [
        {"ddl": "CREATE TABLE pets (id TEXT PRIMARY KEY, name TEXT)"}
    ]


def test_non_ddl_is_not_recorded(db):
    execute_sql(db, "CREATE TABLE pets (id TEXT PRIMARY KEY)")
    execute_sql(db, "INSERT INTO pets (id) VALUES ('x')")
    assert len(execute_sql(db, "SELECT ddl FROM _schema_log")) == 1


def test_create_table_adds_sync_columns(db):
    create_table(db, "people", ["name:text", "birthday:text"])
    cols = {r["name"] for r in execute_sql(db, "PRAGMA table_info(people)")}
    assert {"id", "name", "birthday", "created_at", "updated_at", "deleted_at"} <= cols


def test_create_table_autofills_id_and_timestamps(db):
    create_table(db, "people", ["name:text"])
    execute_sql(db, "INSERT INTO people (name) VALUES ('Ada')")
    row = execute_sql(db, "SELECT id, created_at, updated_at FROM people")[0]
    assert len(row["id"]) == 32
    assert row["created_at"] == row["updated_at"]


def test_create_table_typed_syntax_writes_catalog_rows(db):
    from soma.catalog import properties

    create_table(
        db,
        "places",
        ["name:text!", "status:select!(want|been)", "tags:multi_select(bar|cafe)", "lat:number"],
    )
    cols = {r["name"]: r["type"] for r in execute_sql(db, "PRAGMA table_info(places)")}
    assert cols["status"] == "TEXT" and cols["lat"] == "REAL"
    with connect(db) as conn:
        p = {x["col"]: x for x in properties(conn, "places")}
    assert p["name"]["required"] == 1
    assert p["status"]["options"] == [{"v": "want"}, {"v": "been"}]
    assert p["tags"]["type"] == "multi_select"
    with pytest.raises(catalog.ValidationError):
        insert_rows(db, "places", [{"name": "x", "status": "Been"}])


def test_create_table_unknown_type_maps_storage_to_catalog_type(db):
    from soma.catalog import properties

    create_table(db, "trips", ["lat:real", "n:integer"])
    cols = {r["name"]: r["type"] for r in execute_sql(db, "PRAGMA table_info(trips)")}
    assert cols["lat"] == "REAL" and cols["n"] == "INTEGER"
    with connect(db) as conn:
        p = {x["col"]: x for x in properties(conn, "trips")}
    assert p["lat"]["type"] == "number"
    assert p["n"]["type"] == "int"


def test_update_bumps_updated_at(db):
    create_table(db, "people", ["name:text"])
    execute_sql(db, "INSERT INTO people (name) VALUES ('Ada')")
    before = execute_sql(db, "SELECT updated_at FROM people")[0]["updated_at"]
    time.sleep(0.002)
    execute_sql(db, "UPDATE people SET name = 'Grace'")
    assert execute_sql(db, "SELECT updated_at FROM people")[0]["updated_at"] > before


def test_insert_rows_bulk_and_json_columns(db):
    create_table(db, "people", ["name:text", "tags:text"])
    n = insert_rows(db, "people", [{"name": "Ada", "tags": ["friend"]}, {"name": "Grace"}])
    assert n == 2
    tags = execute_sql(db, "SELECT tags FROM people WHERE name = 'Ada'")[0]["tags"]
    assert json.loads(tags) == ["friend"]


def test_insert_rows_preserves_explicit_id_and_created_at(db):
    create_table(db, "people", ["name:text"])
    insert_rows(
        db, "people", [{"id": "a" * 32, "name": "Ada", "created_at": "2020-01-01T00:00:00.000Z"}]
    )
    row = execute_sql(db, "SELECT id, created_at FROM people")[0]
    assert row["id"] == "a" * 32
    assert row["created_at"] == "2020-01-01T00:00:00.000Z"


def test_dump_sql_roundtrips_schema_and_data(db):
    _mk_people(db, ["Ada"])
    text = dump_sql(db)
    assert "CREATE TABLE" in text and "Ada" in text
    # The versioned dump shape core's validateBackup and the app's restore read.
    assert text.startswith("-- soma-dump: 1\nBEGIN TRANSACTION;\n")
    copy = sqlite3.connect(":memory:")
    copy.executescript(text)
    assert copy.execute("SELECT name FROM people").fetchall() == [("Ada",)]


# --- change detection (drives `soma watch`) ---------------------------------


def test_db_version_changes_after_a_write(db):
    before = db_version(db)
    _mk_people(db, ["Ada"])
    assert db_version(db) != before


def test_db_changed_reports_once_per_change(db):
    _mk_people(db, ["Ada"])
    state = db_version(db)
    changed, state = db_changed(db, state)
    assert changed is False
    execute_sql(db, "UPDATE people SET name = 'Grace'")
    changed, state = db_changed(db, state)
    assert changed is True
    changed, _ = db_changed(db, state)
    assert changed is False


def test_watch_survives_check_failure_but_logs_it(db, hub, monkeypatch, capsys):
    def boom(path, as_of=None):
        raise sqlite3.OperationalError("boom")

    monkeypatch.setattr("soma.catalog.check", boom)
    monkeypatch.setattr("soma.db_changed", lambda path, previous: (True, previous))
    _mk_people(db, ["Ada"])
    watch(db, hub, once=True)  # must not raise
    assert "check failed" in capsys.readouterr().err


def test_watch_survives_any_check_error(db, hub, monkeypatch, capsys):
    """A hard-deleted derived row used to raise TypeError, which the old
    guard did not catch, and the watch daemon died."""

    def boom(path, as_of=None):
        raise TypeError("'NoneType' object is not subscriptable")

    monkeypatch.setattr("soma.catalog.check", boom)
    monkeypatch.setattr("soma.db_changed", lambda path, previous: (True, previous))
    _mk_people(db, ["Ada"])
    watch(db, hub, once=True)  # must not raise
    assert "check failed" in capsys.readouterr().err


def test_watch_prints_check_findings_to_stderr(db, hub, monkeypatch, capsys):
    monkeypatch.setattr("soma.catalog.check", lambda path, as_of=None: [{"rule": "options"}])
    monkeypatch.setattr("soma.db_changed", lambda path, previous: (True, previous))
    _mk_people(db, ["Ada"])
    watch(db, hub, once=True)
    assert json.loads(capsys.readouterr().err)["check"] == [{"rule": "options"}]


# --- sync engine (LocalHub) --------------------------------------------------


def _catalog_rows(path):
    """Rows the catalog itself contributes to a sync: create_table catalogs each
    column (a catalog_properties + catalog_log row), and the engine's own
    provenance contract is cataloged the first time the catalog exists."""
    return sum(
        len(execute_sql(path, f"SELECT id FROM {t}"))
        for t in ("catalog_tables", "catalog_properties", "catalog_rules", "catalog_log")
    )


def test_sync_pushes_schema_and_rows_to_hub(db, hub):
    _mk_people(db, ["Ada", "Grace"])
    stats = sync(db, hub)
    assert stats["pushed"] == 2 + _catalog_rows(db)
    assert {r["name"] for r in hub.rows_pull("people", ["name"], "")} == {"Ada", "Grace"}


def test_second_sync_is_noop(db, hub):
    _mk_people(db, ["Ada"])
    sync(db, hub)
    assert sync(db, hub) == {"pushed": 0, "pulled": 0, "ddl_applied": 0, "rejected": []}
    assert sync(db, hub) == {"pushed": 0, "pulled": 0, "ddl_applied": 0, "rejected": []}


def test_pull_cursor_does_not_skip_rows_written_during_the_pull(db, hub):
    _mk_people(db, ["Ada"])
    sync(db, hub)
    real_pull = hub.rows_pull

    def pull_then_hub_writes(table, columns, since):
        rows = real_pull(table, columns, since)
        if table == "people":  # a hub-side derivation lands after the pull query
            time.sleep(0.002)
            with connect(hub.path) as conn:  # the hub stamps hub_at on its own writes
                conn.execute(
                    f"INSERT INTO people (id, name, hub_at) VALUES ('derived', 'Hub Derived', {NOW})"
                )
        return rows

    hub.rows_pull = pull_then_hub_writes
    sync(db, hub)
    hub.rows_pull = real_pull
    assert sync(db, hub)["pulled"] == 1
    assert (
        execute_sql(db, "SELECT name FROM people WHERE id = 'derived'")[0]["name"] == "Hub Derived"
    )


def test_pull_cursor_does_not_skip_a_replica_pushing_an_older_stamp(db, hub, tmp_path):
    _mk_people(db, ["Ada"])
    sync(db, hub)
    other = init(tmp_path / "other" / "soma.db")
    sync(other, hub)
    execute_sql(other, "UPDATE people SET name = 'B edit'")  # stamped t1, still local to B
    time.sleep(0.002)
    insert_rows(db, "people", [{"name": "Grace"}])  # A's own row, stamped after t1
    real_pull = hub.rows_pull
    fired = []

    def pull_then_b_pushes(table, columns, since):
        rows = real_pull(table, columns, since)
        if table == "people" and not fired:
            fired.append(table)
            sync(other, hub)  # B's t1 edit reaches the hub after A's pull query
        return rows

    hub.rows_pull = pull_then_b_pushes
    sync(db, hub)  # ... and A pushes its newer row in this same sync
    hub.rows_pull = real_pull
    sync(db, hub)
    assert {r["name"] for r in execute_sql(db, "SELECT name FROM people")} == {"B edit", "Grace"}


def test_late_push_with_old_stamp_is_pulled_by_other_replicas(db, hub, tmp_path):
    """The pull cursor is the HUB's arrival time, not a client stamp: a replica
    that pushes late with an old `updated_at` still reaches everyone else."""
    _mk_people(db, ["Ada"])
    sync(db, hub)
    other = init(tmp_path / "other" / "soma.db")
    sync(other, hub)
    execute_sql(other, "UPDATE people SET name = 'B edit'")  # stamped t1, offline
    time.sleep(0.002)
    insert_rows(db, "people", [{"name": "Grace"}])  # A's own row, newer than t1
    sync(db, hub)
    sync(db, hub)  # A's cursor is now past B's t1 stamp
    sync(other, hub)  # B finally pushes: the hub stamps its arrival NOW
    sync(db, hub)
    assert {r["name"] for r in execute_sql(db, "SELECT name FROM people")} == {"B edit", "Grace"}


def test_hub_at_is_assigned_by_hub_not_client(db, hub):
    _mk_people(db, ["Ada"])
    sync(db, hub)
    with connect(hub.path) as conn:
        stamped = conn.execute("SELECT hub_at FROM people").fetchone()["hub_at"]
    assert stamped and stamped > "2"
    out = hub.rows_push(
        "people",
        ["id", "name", "updated_at", "hub_at"],
        [{"id": "x", "name": "Faked", "updated_at": "2099-01-01T00:00:00.000Z", "hub_at": "1970"}],
    )
    with connect(hub.path) as conn:
        row = conn.execute("SELECT hub_at FROM people WHERE id = 'x'").fetchone()
    assert row["hub_at"] == out["hub_at"] != "1970"


def test_ensure_hub_at_backfills_existing_tables_and_forces_one_full_pull(db, hub, tmp_path):
    from soma import ensure_hub_at

    _mk_people(db, ["Ada"])
    # a replica upgraded from before hub_at existed: drop the column back off
    with connect(db) as conn:
        conn.execute("ALTER TABLE people DROP COLUMN hub_at")
    assert "hub_at" not in {r["name"] for r in execute_sql(db, "PRAGMA table_info(people)")}
    assert ensure_hub_at(db) is True
    assert "hub_at" in {r["name"] for r in execute_sql(db, "PRAGMA table_info(people)")}
    assert ensure_hub_at(db) is False  # idempotent
    assert sync(db, hub)["pushed"] >= 1


def test_hub_stamps_from_its_own_schema_when_the_push_omits_hub_at(db, hub, tmp_path):
    """An un-upgraded client (deploy window) pushes without hub_at in `columns`.
    The hub stamps anyway, or those rows are invisible to every replica whose
    cursor has moved on."""
    _mk_people(db, ["Ada"])
    sync(db, hub)
    other = init(tmp_path / "other" / "soma.db")
    sync(other, hub)  # `other` now has a non-empty pull cursor
    old_client_cols = ["id", "name", "updated_at"]
    out = hub.rows_push(
        "people",
        old_client_cols,
        [{"id": "legacy", "name": "Legacy", "updated_at": "2099-01-01T00:00:00.000Z"}],
    )
    with connect(hub.path) as conn:
        stamped = conn.execute("SELECT hub_at FROM people WHERE id = 'legacy'").fetchone()
    assert stamped["hub_at"] == out["hub_at"] and out["hub_at"]
    assert sync(other, hub)["pulled"] == 1
    assert execute_sql(other, "SELECT name FROM people WHERE id = 'legacy'")[0]["name"] == "Legacy"


def test_hub_falls_back_to_updated_at_on_a_table_without_hub_at(db, hub):
    """A new hub still serves an old client's tables: cursor and pull degrade to
    the pre-migration `updated_at` behaviour instead of erroring."""
    with connect(hub.path) as conn:
        conn.execute("CREATE TABLE legacy (id TEXT PRIMARY KEY, name TEXT, updated_at TEXT)")
        conn.execute("INSERT INTO legacy VALUES ('a', 'Ada', '2026-01-01T00:00:00.000Z')")
        conn.execute("INSERT INTO legacy VALUES ('g', 'Grace', '2026-02-01T00:00:00.000Z')")
    assert hub.cursor(["legacy"]) == "2026-02-01T00:00:00.000Z"
    cols = ["id", "name", "updated_at"]
    assert len(hub.rows_pull("legacy", cols, "")) == 2
    assert [r["id"] for r in hub.rows_pull("legacy", cols, "2026-01-15T00:00:00.000Z")] == ["g"]


def test_upgrade_from_a_pre_hub_at_estate_converges(db, hub, tmp_path):
    """The one-time migration: an existing replica and hub whose tables predate
    hub_at, with a last_pull holding an updated_at-shaped stamp."""
    _mk_people(db, ["Ada"])
    sync(db, hub)
    for path in (db, hub.path):  # rewind both sides to the pre-hub_at shape
        with connect(path) as conn:
            for t in [
                r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
            ]:
                if not t.startswith(("_", "sqlite_")):
                    conn.execute(f'ALTER TABLE "{t}" DROP COLUMN hub_at')
    stale = execute_sql(db, "SELECT max(updated_at) AS m FROM people")[0]["m"]
    execute_sql(db, f"UPDATE _sync_state SET value = '{stale}' WHERE key = 'last_pull'")

    stats = sync(db, hub)  # the ALTERs replay to the hub in this same sync
    assert stats["ddl_applied"] >= 1
    assert execute_sql(db, "SELECT hub_at FROM people")  # column is back
    with connect(hub.path) as conn:
        assert conn.execute("SELECT hub_at FROM people").fetchone()["hub_at"]

    other = init(tmp_path / "other" / "soma.db")
    sync(other, hub)
    assert {r["name"] for r in execute_sql(other, "SELECT name FROM people")} == {"Ada"}
    assert sync(db, hub) == {"pushed": 0, "pulled": 0, "ddl_applied": 0, "rejected": []}


def test_hub_rejects_bad_row_but_accepts_rest(db, hub):
    from soma.catalog import set_property

    create_table(db, "places", ["status:text"])
    set_property(db, "places", "status", type="select", options=[{"v": "want"}])
    insert_rows(db, "places", [{"id": "good", "status": "want"}])
    sync(db, hub)  # catalog reaches the hub first
    # a raw write that bypasses local validation
    c = sqlite3.connect(db)
    c.execute("INSERT INTO places (id, status) VALUES ('bad', 'Nope')")
    c.commit()
    c.close()
    stats = sync(db, hub)
    assert stats["rejected"][0]["id"] == "bad" and stats["rejected"][0]["rule"] == "options"
    assert {r["id"] for r in hub.rows_pull("places", ["id"], "")} == {"good"}
    assert sync(db, hub)["rejected"]  # rejected edits remain pending until repaired


@pytest.fixture()
def shape_hub(hub):
    init(hub.path)
    create_table(hub.path, "places", ["name:text!", "status:select(want)"])
    insert_rows(
        hub.path,
        "places",
        [
            {"id": rid, "name": "A", "status": "want", "updated_at": "2026-09-03T00:00:00.000Z"}
            for rid in ("a", "b", "c")
        ],
    )
    return hub


@pytest.mark.parametrize("stamp", [{}, {"updated_at": None}], ids=["missing", "null"])
def test_hub_unstamped_rows_never_gain_default_write_precedence(hub, stamp):
    init(hub.path)
    create_table(hub.path, "stamped", ["name:text!"])
    insert_rows(
        hub.path,
        "stamped",
        [
            {"id": "a", "name": "stored", "updated_at": "2000-01-01T00:00:00.000Z"},
        ],
    )
    cols = ["id", "name", "updated_at"]
    out = hub.rows_push(
        "stamped",
        cols,
        [
            {"id": "a", "name": "first", "updated_at": "2001-01-01T00:00:00.000Z"},
            {"id": "a", "name": "unstamped overwrite", **stamp},
            {"id": "new", "name": "unstamped insert", **stamp},
        ],
    )
    assert out["upserted"] == 1
    assert [(r["id"], r["col"], r["rule"]) for r in out["rejected"]] == [
        ("a", "updated_at", "required"),
        ("new", "updated_at", "required"),
    ]
    expected = [{"id": "a", "name": "first", "updated_at": "2001-01-01T00:00:00.000Z"}]
    assert hub.rows_pull("stamped", cols, "") == expected
    out = hub.rows_push(
        "stamped",
        ["id", "name"],
        [
            {"id": "a", "name": "unlisted overwrite", "updated_at": "2002-01-01T00:00:00.000Z"},
        ],
    )
    assert out["upserted"] == 0
    assert out["rejected"][0]["col"] == "updated_at"
    assert out["rejected"][0]["rule"] == "required"
    assert hub.rows_pull("stamped", cols, "") == expected


def test_hub_heterogeneous_rows_preserve_omitted_required_fields(shape_hub):
    hub = shape_hub
    cols = ["id", "name", "status", "updated_at", "hub_at"]
    before = hub.rows_pull("places", cols, "")
    stamp = "2026-09-09T00:00:00.000Z"
    out = hub.rows_push(
        "places",
        cols,
        [
            {"id": "a", "status": None, "updated_at": stamp},
            {"id": "b", "name": "B", "updated_at": stamp},
            {"id": "c", "name": None, "status": "want", "updated_at": stamp},
        ],
    )
    assert out["upserted"] == 2
    assert [(r["id"], r["col"], r["rule"]) for r in out["rejected"]] == [("c", "name", "required")]
    stored = {r["id"]: r for r in hub.rows_pull("places", cols, "")}
    assert (stored["a"]["name"], stored["a"]["status"]) == ("A", None)
    assert (stored["b"]["name"], stored["b"]["status"]) == ("B", "want")
    assert stored["c"] == next(r for r in before if r["id"] == "c")


def test_hub_required_insert_value_outside_columns_is_rejected(shape_hub):
    out = shape_hub.rows_push(
        "places",
        ["id", "updated_at"],
        [
            {"id": "new", "name": "not written", "updated_at": "2026-09-09T00:00:00.000Z"},
        ],
    )
    assert out["upserted"] == 0
    assert out["rejected"][0]["rule"] == "required"
    assert "new" not in {r["id"] for r in shape_hub.rows_pull("places", ["id"], "")}


def test_hub_unlisted_values_are_not_validated_or_written(shape_hub):
    out = shape_hub.rows_push(
        "places",
        ["id", "name", "updated_at"],
        [
            {
                "id": "a",
                "name": "B",
                "status": "invalid but unlisted",
                "updated_at": "2026-09-09T00:00:00.000Z",
            },
        ],
    )
    assert out["rejected"] == []
    stored = next(
        r for r in shape_hub.rows_pull("places", ["id", "name", "status"], "") if r["id"] == "a"
    )
    assert stored == {"id": "a", "name": "B", "status": "want"}


def test_hub_heterogeneous_pushes_preserve_timestamp_order_without_echo(shape_hub):
    hub = shape_hub
    cols = ["id", "name", "status", "updated_at", "hub_at"]
    out = hub.rows_push(
        "places",
        cols,
        [
            {"id": "a", "status": "want", "updated_at": "2026-09-09T00:00:00.000Z"},
            {"id": "a", "name": "first", "updated_at": "2026-09-10T00:00:00.000Z"},
            {"id": "a", "status": None, "updated_at": "2026-09-10T00:00:00.000Z"},
        ],
    )
    assert out["rejected"] == []
    stored = {r["id"]: r for r in hub.rows_pull("places", cols, "")}
    assert (stored["a"]["name"], stored["a"]["status"]) == ("first", "want")
    hub.rows_push(
        "places",
        cols,
        [
            {"id": "a", "name": "second", "updated_at": "2026-09-11T00:00:00.000Z"},
            {"id": "a", "status": None, "updated_at": "2026-09-12T00:00:00.000Z"},
        ],
    )
    stored = hub.rows_pull("places", cols, "")
    a = next(r for r in stored if r["id"] == "a")
    assert (a["name"], a["status"]) == ("second", None)
    hub.rows_push(
        "places",
        ["id", "name", "updated_at"],
        [
            {"id": "a", "name": "stale", "updated_at": "2026-09-11T00:00:00.000Z"},
        ],
    )
    assert hub.rows_pull("places", cols, "") == stored


def test_hub_sql_failure_rolls_back_heterogeneous_accepted_rows(shape_hub):
    hub = shape_hub
    with connect(hub.path) as conn:
        conn.execute(
            "CREATE TRIGGER block_name BEFORE UPDATE ON places "
            "WHEN NEW.name='blocked' BEGIN SELECT RAISE(ABORT, 'blocked'); END"
        )
    cols = ["id", "name", "status", "updated_at", "hub_at"]
    before = hub.rows_pull("places", cols, "")
    with pytest.raises(sqlite3.IntegrityError, match="blocked"):
        hub.rows_push(
            "places",
            cols,
            [
                {"id": "a", "status": None, "updated_at": "2026-09-09T00:00:00.000Z"},
                {"id": "a", "name": "blocked", "updated_at": "2026-09-10T00:00:00.000Z"},
            ],
        )
    assert hub.rows_pull("places", cols, "") == before


def test_hub_rejects_derived_change_without_matching_provenance(db, hub):
    from soma.catalog import inputs_hash, set_property, value_hash

    create_table(db, "movies", ["title:text", "slug:text"])
    set_property(db, "movies", "slug", type="text", derived_by="http:slug", inputs=["title"])
    insert_rows(db, "movies", [{"id": "m1", "title": "A"}])
    # the hub's derive engine wrote the value and its provenance; stand in for it
    with connect(db) as conn:
        conn.execute("UPDATE movies SET slug = 'a' WHERE id = 'm1'")
        conn.execute(
            "INSERT INTO provenance (id, to_kind, to_ref, field, from_kind, from_ref, rel, asserted_by, inputs_hash, value_hash) "
            "VALUES ('movies:m1:slug', 'movies', 'm1', 'slug', 'http:slug', 'x', 'derived_from', 'hub', ?, ?)",
            (
                inputs_hash(conn, "movies", "m1", ["title"]),
                value_hash(conn, "movies", "m1", "slug"),
            ),
        )
    sync(db, hub)
    c = sqlite3.connect(db)
    c.execute("UPDATE movies SET slug = 'hand' WHERE id = 'm1'")
    c.commit()
    c.close()
    time.sleep(0.002)
    stats = sync(db, hub)
    assert stats["rejected"][0]["rule"] == "provenance"
    assert hub.rows_pull("movies", ["slug"], "")[0]["slug"] == "a"


def test_sync_pushes_catalog_and_provenance_before_data(db, hub, monkeypatch):
    from soma import _user_tables
    from soma.catalog import ensure_catalog

    _mk_people(db, ["Ada"])
    ensure_catalog(db)
    order = _user_tables(db)
    assert order.index("provenance") < order.index("people")
    assert order.index("catalog_properties") < order.index("people")


def test_sync_pushes_rows_before_rows_whose_invariants_need_them(db, hub):
    from soma.catalog import set_rule

    # Name order would push overlay first, and the hub's invariant would
    # reject it until the next round brought its transaction.
    create_table(db, "txns_x", ["amount:int"])
    create_table(db, "overlay", ["source_id:text"])
    set_rule(
        db,
        "overlay-row-exists",
        scope="table",
        tbl="overlay",
        kind="invariant",
        enforce=1,
        text="An overlay points at a live transaction.",
        sql="SELECT c.id FROM changed c WHERE NOT EXISTS "
        "(SELECT 1 FROM txns_x t WHERE t.id = c.source_id AND t.deleted_at IS NULL)",
    )
    sync(db, hub)
    insert_rows(db, "txns_x", [{"id": "t1", "amount": 5}])
    insert_rows(db, "overlay", [{"source_id": "t1"}])
    assert sync(db, hub)["rejected"] == []
    assert [r["source_id"] for r in hub.rows_pull("overlay", ["source_id"], "")] == ["t1"]


def test_sync_pushes_rows_after_the_rows_they_reference(db, hub):
    from soma.catalog import set_property

    # Name order would push a_child first and the hub would reject its ref
    # until the next round brought the z_parent row.
    create_table(db, "z_parent", ["name:text"])
    create_table(db, "a_child", ["parent_id:ref"])
    set_property(db, "a_child", "parent_id", ref_table="z_parent")
    sync(db, hub)
    insert_rows(db, "z_parent", [{"id": "p1", "name": "P"}])
    insert_rows(db, "a_child", [{"id": "c1", "parent_id": "p1"}])
    assert sync(db, hub)["rejected"] == []
    assert [r["id"] for r in hub.rows_pull("a_child", ["id"], "")] == ["c1"]


def test_a_deprecated_value_rides_along_with_edits_but_is_never_written(db, hub):
    from soma.catalog import set_property

    create_table(db, "items", ["name:text", "legacy:bool"])
    insert_rows(db, "items", [{"id": "kept", "name": "A", "legacy": 1}])
    sync(db, hub)
    set_property(db, "items", "legacy", deprecated=1)
    sync(db, hub)
    # An edit to another column keeps the preserved value, locally and on the hub.
    execute_sql(db, "UPDATE items SET name = 'B' WHERE id = 'kept'")
    assert sync(db, hub)["rejected"] == []
    assert hub.rows_pull("items", ["id", "name", "legacy"], "") == [
        {"id": "kept", "name": "B", "legacy": 1}
    ]
    with pytest.raises(Exception, match="deprecated"):
        execute_sql(db, "UPDATE items SET legacy = 0 WHERE id = 'kept'")
    with pytest.raises(Exception, match="deprecated"):
        insert_rows(db, "items", [{"id": "new", "name": "C", "legacy": 1}])
    execute_sql(db, "UPDATE items SET legacy = NULL WHERE id = 'kept'")


def test_fresh_replica_pulls_schema_and_rows_without_echoing(db, hub, tmp_path):
    _mk_people(db, ["Ada", "Grace"])
    sync(db, hub)
    other = init(tmp_path / "other" / "soma.db")
    stats = sync(other, hub)
    assert (
        stats["ddl_applied"] >= 1
        and stats["pulled"] == 2 + _catalog_rows(db)
        and stats["pushed"] == 0
    )
    assert {r["name"] for r in execute_sql(other, "SELECT name FROM people")} == {"Ada", "Grace"}


def test_lww_newer_edit_wins(db, hub, tmp_path):
    _mk_people(db, ["Ada"])
    sync(db, hub)
    other = init(tmp_path / "other" / "soma.db")
    sync(other, hub)
    execute_sql(other, "UPDATE people SET name = 'Ada Lovelace'")
    time.sleep(0.002)
    execute_sql(db, "UPDATE people SET name = 'Countess Ada'")  # newer
    sync(other, hub)
    sync(db, hub)
    sync(other, hub)
    assert execute_sql(db, "SELECT name FROM people")[0]["name"] == "Countess Ada"
    assert execute_sql(other, "SELECT name FROM people")[0]["name"] == "Countess Ada"


def test_soft_delete_propagates(db, hub, tmp_path):
    _mk_people(db, ["Ada"])
    sync(db, hub)
    other = init(tmp_path / "other" / "soma.db")
    sync(other, hub)
    execute_sql(db, "UPDATE people SET deleted_at = updated_at")
    sync(db, hub)
    sync(other, hub)
    assert execute_sql(other, "SELECT deleted_at FROM people")[0]["deleted_at"] is not None


def test_added_column_replays_to_other_replica(db, hub, tmp_path):
    _mk_people(db, ["Ada"])
    sync(db, hub)
    other = init(tmp_path / "other" / "soma.db")
    sync(other, hub)
    execute_sql(db, "ALTER TABLE people ADD COLUMN nickname TEXT")
    sync(db, hub)
    sync(other, hub)
    cols = {r["name"] for r in execute_sql(other, "PRAGMA table_info(people)")}
    assert "nickname" in cols


# --- HTTP hub (wire format against a real socket) ---------------------------


class _Handler(BaseHTTPRequestHandler):
    hub = None
    token = "testtoken"
    last_user_agent = None
    streams: ClassVar[dict] = {}
    batches: ClassVar[dict] = {}
    derive_calls: ClassVar[list] = []
    derive_fail_id = None

    def log_message(self, *a):
        pass

    def _deny(self):
        denied = b'{"error":"forbidden"}'
        self.send_response(403)
        self.send_header("Content-Length", str(len(denied)))
        self.end_headers()
        self.wfile.write(denied)

    def _json(self, obj):
        payload = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.headers.get("Authorization") != f"Bearer {self.token}":
            self._deny()
            return
        parts = self.path.strip("/").split("/")
        if len(parts) == 4 and parts[:2] == ["v1", "streams"] and parts[3] == "tail":
            records = _Handler.streams.get(parts[2], [])
            self._json(json.loads(records[-1]) if records else None)
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        raw = self.rfile.read(int(self.headers["Content-Length"]))  # always drain the request
        _Handler.last_user_agent = self.headers.get("User-Agent")
        if self.headers.get("Authorization") != f"Bearer {self.token}":
            self._deny()
            return
        parts = self.path.strip("/").split("/")
        if parts[:2] == ["v1", "tokens"]:
            body = json.loads(raw or "{}")
        if parts == ["v1", "tokens", "create"]:
            _Handler.tokens = getattr(_Handler, "tokens", {})
            _Handler.tokens[body["name"]] = body["scopes"]
            self._json({"name": body["name"], "token": "lt_" + "x" * 40, "scopes": body["scopes"]})
            return
        if parts == ["v1", "tokens", "revoke"]:
            _Handler.tokens.pop(body["name"], None)
            self._json({"revoked": body["name"]})
            return
        if parts == ["v1", "tokens", "list"]:
            self._json(
                [{"name": n, "scopes": s} for n, s in getattr(_Handler, "tokens", {}).items()]
            )
            return
        if parts == ["v1", "archive", "query"]:
            self._json({"result": {"rows": [{"stream": "location", "n": 4}]}})
            return
        if len(parts) == 4 and parts[:2] == ["v1", "streams"] and parts[3] == "batch":
            records = json.loads(raw)
            _Handler.batches.setdefault(parts[2], []).append(records)
            self._json({"count": len(records), "key": "landing/x-batch.json"})
            return
        if len(parts) == 4 and parts[:2] == ["v1", "streams"] and parts[3] == "append":
            _Handler.streams.setdefault(parts[2], []).append(raw.decode())
            self._json({"key": f"landing/{parts[2]}/test.json"})
            return
        if parts == ["v1", "derive"]:
            body = json.loads(raw or "{}")
            _Handler.derive_calls.append(body)
            ids = body["ids"]
            failed = []
            if _Handler.derive_fail_id in ids:
                failed = [{"id": _Handler.derive_fail_id, "col": body.get("col"), "error": "boom"}]
            self._json({"derived": len(ids) - len(failed), "failed": failed})
            return
        body = json.loads(raw or "{}")
        h = self.hub
        if self.path == "/v1/schema/pull":
            out = {"entries": h.schema_pull()}
        elif self.path == "/v1/schema/push":
            out = {"applied": h.schema_push(body["entries"])}
        elif self.path == "/v1/rows/pull":
            out = {"rows": h.rows_pull(body["table"], body["columns"], body["since"])}
        elif self.path == "/v1/rows/push":
            out = h.rows_push(
                body["table"], body["columns"], body["rows"], history=body.get("history")
            )
        elif self.path == "/v1/cursor":
            out = {"max_hub_at": h.cursor(body["tables"])}
        else:
            self.send_response(404)
            self.end_headers()
            return
        payload = json.dumps(out).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def _serve(hub_db):
    backing = LocalHub(hub_db)
    backing.ensure_ready()
    _Handler.hub = backing
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


@pytest.fixture()
def http_hub(tmp_path):
    server = _serve(tmp_path / "server.db")
    yield HttpHub(f"http://127.0.0.1:{server.server_port}", {"Authorization": "Bearer testtoken"})
    server.shutdown()


def test_cli_backdated_import_reaches_http_hub(tmp_path, http_hub, monkeypatch):
    """A successful CLI sync must deliver imports without changing source stamps."""
    replica = tmp_path / "cli"
    replica.mkdir()
    (replica / "config.json").write_text(json.dumps({"hub_url": http_hub.base}))
    monkeypatch.setenv("SOMA_DATA_DIR", str(replica))
    monkeypatch.setenv("SOMA_HUB_TOKEN", "testtoken")

    def cli(*args, rows=None):
        result = subprocess.run(
            [sys.executable, "-c", "from soma import main; main()", *args],
            input=json.dumps(rows) if rows is not None else "",
            text=True,
            capture_output=True,
            check=True,
        )
        return result.stdout

    cli("init")
    cli("table", "create", "items", "name:text")
    cli("sync")
    stamp = "2001-01-01T00:00:00.000Z"
    cli("insert", "items", rows=[{"id": "old", "name": "import", "updated_at": stamp}])
    assert not json.loads(cli("sync"))["rejected"]
    assert http_hub.rows_pull("items", ["id", "updated_at"], "") == [
        {"id": "old", "updated_at": stamp}
    ]
    assert http_hub.cursor(["items"])


def test_sync_works_end_to_end_over_http(db, http_hub, tmp_path):
    _mk_people(db, ["Ada", "Grace"])
    assert sync(db, http_hub)["pushed"] == 2 + _catalog_rows(db)
    other = init(tmp_path / "other" / "soma.db")
    assert sync(other, http_hub)["pulled"] == 2 + _catalog_rows(db)
    assert {r["name"] for r in execute_sql(other, "SELECT name FROM people")} == {"Ada", "Grace"}


def test_http_hub_rejects_bad_credentials(db, tmp_path):
    server = _serve(tmp_path / "server2.db")
    bad = HttpHub(f"http://127.0.0.1:{server.server_port}", {"Authorization": "Bearer wrong"})
    _mk_people(db, ["Ada"])
    with pytest.raises(RuntimeError, match="403"):
        sync(db, bad)
    server.shutdown()


# --- CLI ---------------------------------------------------------------------


def test_cli_init_table_insert_sql_roundtrip(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("SOMA_DATA_DIR", str(tmp_path))
    assert main(["init"]) == 0
    assert main(["table", "create", "pets", "name:text"]) == 0
    monkeypatch.setattr("sys.stdin", io.StringIO('[{"name": "Rex"}]'))
    assert main(["insert", "pets"]) == 0
    capsys.readouterr()
    assert main(["sql", "SELECT name FROM pets"]) == 0
    assert json.loads(capsys.readouterr().out) == [{"name": "Rex"}]


def test_cli_path_prints_db_path(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("SOMA_DATA_DIR", str(tmp_path))
    assert main(["path"]) == 0
    assert capsys.readouterr().out.strip() == str(tmp_path / "soma.db")


def test_cli_export_writes_sql_to_stdout(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("SOMA_DATA_DIR", str(tmp_path))
    main(["init"])
    main(["table", "create", "pets", "name:text"])
    capsys.readouterr()
    assert main(["export"]) == 0
    assert 'CREATE TABLE "pets"' in capsys.readouterr().out


def test_http_hub_default_timeout_covers_slow_stream_tees():
    """The hub's pipeline tee can stall past 30s; a short client timeout makes
    a fully-successful batch look failed and invites duplicating retries."""
    hub = HttpHub("http://127.0.0.1:1")
    assert hub.timeout >= 120


def test_http_hub_sends_a_real_user_agent(db, http_hub):
    """Cloudflare's edge bot-protection 403s the default Python-urllib agent."""
    _mk_people(db, ["Ada"])
    sync(db, http_hub)
    assert _Handler.last_user_agent.startswith("soma/")


# --- streams & archive -------------------------------------------------------


def test_expand_stream_sql_unions_parquet_and_landing():
    from soma import expand_stream_sql

    manifest = {
        "parquet": ["https://hub/v1/archive/parquet/location/year%3D2026/part-0.parquet"],
        "landing": ["https://hub/v1/archive/landing/location/a.json"],
    }
    sql = expand_stream_sql("SELECT count(*) FROM stream('location')", {"location": manifest})
    assert "read_parquet" in sql and "read_json" in sql and "UNION ALL BY NAME" in sql
    assert "stream(" not in sql


def test_expand_stream_sql_parquet_only():
    from soma import expand_stream_sql

    manifest = {"parquet": ["https://hub/p.parquet"], "landing": []}
    sql = expand_stream_sql("SELECT * FROM stream('location')", {"location": manifest})
    assert "read_parquet" in sql and "read_json" not in sql


def test_expand_stream_sql_empty_stream_raises():
    from soma import expand_stream_sql

    with pytest.raises(RuntimeError, match="empty"):
        expand_stream_sql("SELECT * FROM stream('x')", {"x": {"parquet": [], "landing": []}})


def test_cli_stream_append_posts_body_and_tail_reads_back(monkeypatch, tmp_path, capsys):
    server = _serve(tmp_path / "server3.db")
    monkeypatch.setenv("SOMA_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SOMA_HUB_URL", f"http://127.0.0.1:{server.server_port}")
    monkeypatch.setenv("SOMA_HUB_TOKEN", "testtoken")
    monkeypatch.setattr("sys.stdin", io.StringIO('{"lat": 42.36, "lon": -71.09}'))
    assert main(["stream", "append", "location"]) == 0
    capsys.readouterr()
    assert main(["stream", "tail", "location"]) == 0
    assert json.loads(capsys.readouterr().out) == {"lat": 42.36, "lon": -71.09}
    server.shutdown()


def test_cli_archive_query_proxies_sql_through_hub(monkeypatch, tmp_path, capsys):
    server = _serve(tmp_path / "server4.db")
    monkeypatch.setenv("SOMA_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SOMA_HUB_URL", f"http://127.0.0.1:{server.server_port}")
    monkeypatch.setenv("SOMA_HUB_TOKEN", "testtoken")
    assert main(["archive", "query", "SELECT count(*) AS n FROM soma.events"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["result"]["rows"][0]["n"] == 4
    server.shutdown()


# --- scoped tokens -----------------------------------------------------------


def test_cli_token_create_list_revoke(monkeypatch, tmp_path, capsys):
    server = _serve(tmp_path / "server5.db")
    monkeypatch.setenv("SOMA_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SOMA_HUB_URL", f"http://127.0.0.1:{server.server_port}")
    monkeypatch.setenv("SOMA_HUB_TOKEN", "testtoken")
    assert main(["token", "create", "phone", "--scopes", "streams:append"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["name"] == "phone" and out["token"].startswith("lt_")
    assert main(["token", "list"]) == 0
    listed = json.loads(capsys.readouterr().out)
    assert listed[0]["name"] == "phone" and listed[0]["scopes"] == "streams:append"
    assert main(["token", "revoke", "phone"]) == 0
    assert json.loads(capsys.readouterr().out)["revoked"] == "phone"
    server.shutdown()


def test_cli_stream_import_batches_ndjson(monkeypatch, tmp_path, capsys):
    server = _serve(tmp_path / "server6.db")
    monkeypatch.setenv("SOMA_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SOMA_HUB_URL", f"http://127.0.0.1:{server.server_port}")
    monkeypatch.setenv("SOMA_HUB_TOKEN", "testtoken")
    ndjson = "\n".join(json.dumps({"n": i}) for i in range(1205))
    monkeypatch.setattr("sys.stdin", io.StringIO(ndjson))
    assert main(["stream", "import", "history"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["imported"] == 1205
    assert len(_Handler.batches["history"]) == 3  # 500-record chunks
    assert sum(len(b) for b in _Handler.batches["history"]) == 1205


# --- derive --------------------------------------------------------------


def test_cli_derive_chunks_by_50_and_reports_totals(monkeypatch, tmp_path, capsys):
    server = _serve(tmp_path / "server7.db")
    monkeypatch.setenv("SOMA_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SOMA_HUB_URL", f"http://127.0.0.1:{server.server_port}")
    monkeypatch.setenv("SOMA_HUB_TOKEN", "testtoken")
    _Handler.derive_calls = []
    _Handler.derive_fail_id = None
    main(["init"])
    main(["table", "create", "movies", "title:text", "status:text"])
    monkeypatch.setattr(
        "sys.stdin",
        io.StringIO(json.dumps([{"title": f"m{i}", "status": "x"} for i in range(120)])),
    )
    main(["insert", "movies"])
    capsys.readouterr()
    assert main(["derive", "movies.title", "--where", "status = 'x'"]) == 0
    assert json.loads(capsys.readouterr().out) == {"derived": 120, "failed": []}
    assert [len(c["ids"]) for c in _Handler.derive_calls] == [50, 50, 20]
    assert all(c["table"] == "movies" and c["col"] == "title" for c in _Handler.derive_calls)
    server.shutdown()


def test_cli_derive_reports_failures_and_exits_1(monkeypatch, tmp_path, capsys):
    server = _serve(tmp_path / "server8.db")
    monkeypatch.setenv("SOMA_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SOMA_HUB_URL", f"http://127.0.0.1:{server.server_port}")
    monkeypatch.setenv("SOMA_HUB_TOKEN", "testtoken")
    _Handler.derive_calls = []
    _Handler.derive_fail_id = "m2"
    main(["init"])
    main(["table", "create", "movies", "title:text", "status:text"])
    monkeypatch.setattr(
        "sys.stdin",
        io.StringIO(
            json.dumps([{"id": f"m{i}", "title": f"m{i}", "status": "x"} for i in range(3)])
        ),
    )
    main(["insert", "movies"])
    capsys.readouterr()
    assert main(["derive", "movies.title", "--where", "status = 'x'"]) == 1
    out = json.loads(capsys.readouterr().out)
    assert out["derived"] == 2
    assert out["failed"] == [{"id": "m2", "col": "title", "error": "boom"}]
    server.shutdown()


def test_cli_derive_without_hub_token_fails_clearly(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("SOMA_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("SOMA_HUB_TOKEN", raising=False)
    monkeypatch.delenv("SOMA_HUB_URL", raising=False)
    main(["init"])
    main(["table", "create", "movies", "title:text"])
    capsys.readouterr()
    assert main(["derive", "movies.title"]) == 1
    out, err = capsys.readouterr()
    assert out == ""
    assert "token" in err.lower()
    assert execute_sql(tmp_path / "soma.db", "SELECT count(*) AS n FROM movies")[0]["n"] == 0


# --- quoted identifiers ------------------------------------------------------


def test_qi_quotes_and_rejects_unsafe_identifiers():
    from soma import qi

    assert qi("cast") == '"cast"'
    for bad in ("", "1col", "a-b", "x; DROP TABLE y", 'a"b'):
        with pytest.raises(ValueError):
            qi(bad)


def test_reserved_word_columns_round_trip_through_sync(db, hub, tmp_path):
    create_table(db, "movies", ["cast:text", "order:int", "group:text", "select:text"])
    insert_rows(db, "movies", [{"cast": "Ada", "order": 1, "group": "g", "select": "s"}])
    sync(db, hub)
    other = init(tmp_path / "other" / "soma.db")
    assert sync(other, hub)["pulled"] >= 1
    row = execute_sql(other, 'SELECT "cast", "order", "group", "select" FROM movies')[0]
    assert row == {"cast": "Ada", "order": 1, "group": "g", "select": "s"}
    assert catalog.check(other) == []


def test_schema_replay_skips_a_rename_already_applied(db, tmp_path):
    """A fresh replica creates engine tables in their CURRENT shape, then
    replays the log - a logged RENAME COLUMN of a column it never had is
    already applied, not an error (same idempotent-by-skip as CREATE/ADD)."""
    from soma import _apply_local_ddl

    execute_sql(db, "CREATE TABLE t (id TEXT PRIMARY KEY, b TEXT)")
    entry = {"applied_at": "2026-09-07T00:00:00.000Z", "ddl": "ALTER TABLE t RENAME COLUMN a TO b"}
    _apply_local_ddl(db, entry)
    assert entry["ddl"] in {r["ddl"] for r in execute_sql(db, "SELECT ddl FROM _schema_log")}
    hub = LocalHub(tmp_path / "hub.db")
    hub.ensure_ready()
    hub._query("CREATE TABLE t (id TEXT PRIMARY KEY, b TEXT)")
    assert hub.schema_push([entry]) == 1


# --- table rename -----------------------------------------------------------


def _mk_estate(path):
    """people (with a rule, a derived column + provenance, history) and pets
    referencing it: every place a table name can hide."""
    create_table(path, "people", ["name:text!", "slug:text", "status:select(new|met)"])
    create_table(path, "pets", ["name:text", "owner:ref"])
    catalog.set_property(path, "pets", "owner", type="ref", ref_table="people")
    catalog.set_property(
        path, "people", "slug", type="text", derived_by="http:slug", inputs=["name"]
    )
    catalog.set_table(path, "people", purpose="everyone")
    catalog.set_rule(
        path,
        "people-named",
        scope="table",
        tbl="people",
        kind="invariant",
        text="a person has a name",
        sql="SELECT id FROM people WHERE name = '' AND id IN (SELECT id FROM changed)",
        enforce=1,
    )
    insert_rows(path, "people", [{"id": "a1", "name": "Ada", "status": "new"}])
    execute_sql(path, "UPDATE people SET status = 'met' WHERE id = 'a1'")
    insert_rows(
        path,
        "provenance",
        [
            {
                "id": "people:a1:slug",
                "from_kind": "http:slug",
                "from_ref": "h",
                "to_kind": "people",
                "to_ref": "a1",
                "rel": "derived_from",
                "field": "slug",
                "asserted_by": "hub",
            },
            {
                "id": "imessage:G1:a1",
                "from_kind": "imessage",
                "from_ref": "G1",
                "to_kind": "people",
                "to_ref": "a1",
                "rel": "mentions",
                "asserted_by": "test",
            },
        ],
    )


def _live(path, table, **where):
    cond = " AND ".join(f"{k} = '{v}'" for k, v in where.items())
    return execute_sql(path, f"SELECT * FROM {table} WHERE deleted_at IS NULL AND {cond}")


def test_rename_table_moves_every_reference_in_one_transaction(db):
    _mk_estate(db)
    rename_table(db, "people", "humans")
    names = {
        r["name"] for r in execute_sql(db, "SELECT name FROM sqlite_master WHERE type='table'")
    }
    assert "humans" in names and "people" not in names
    trig = {
        r["name"] for r in execute_sql(db, "SELECT name FROM sqlite_master WHERE type='trigger'")
    }
    assert "humans_updated_at" in trig and "people_updated_at" not in trig
    # catalog: properties and the table row rekeyed, old ids soft-deleted, refs repointed
    assert {p["id"] for p in _live(db, "catalog_properties", tbl="humans")} == {
        "humans.name",
        "humans.slug",
        "humans.status",
    }
    assert _live(db, "catalog_properties", tbl="people") == []
    assert _live(db, "catalog_tables", id="humans")[0]["purpose"] == "everyone"
    assert _live(db, "catalog_tables", id="people") == []
    assert _live(db, "catalog_properties", id="pets.owner")[0]["ref_table"] == "humans"
    rule = _live(db, "catalog_rules", id="people-named")[0]
    assert rule["tbl"] == "humans" and "FROM humans WHERE" in rule["sql"]
    # provenance: derived ids rekeyed, edges repointed
    assert _live(db, "provenance", to_kind="people") == []
    assert _live(db, "provenance", id="humans:a1:slug")[0]["to_kind"] == "humans"
    assert _live(db, "provenance", id="imessage:G1:a1")[0]["to_kind"] == "humans"
    # history follows the table
    assert {r["tbl"] for r in execute_sql(db, "SELECT tbl FROM history")} == {"humans"}
    # the renamed table still works: trigger, validation, rule, history
    execute_sql(db, "UPDATE humans SET status = 'new' WHERE id = 'a1'")
    row = execute_sql(db, "SELECT * FROM humans")[0]
    assert row["updated_at"] > row["created_at"]
    with pytest.raises(catalog.ValidationError) as exc:
        execute_sql(db, "UPDATE humans SET name = '' WHERE id = 'a1'")
    assert "people-named" in {v.rule for v in exc.value.violations}
    assert [r["col"] for r in execute_sql(db, "SELECT col FROM history WHERE tbl = 'humans'")] == [
        "status",
        "status",
    ]
    ddls = [r["ddl"] for r in execute_sql(db, "SELECT ddl FROM _schema_log")]
    assert 'ALTER TABLE "people" RENAME TO "humans"' in ddls


def test_rename_table_refuses_bad_targets(db):
    _mk_people(db, ["Ada"])
    with pytest.raises(ValueError, match="no such table"):
        rename_table(db, "nope", "x")
    with pytest.raises(ValueError, match="already exists"):
        rename_table(db, "people", "catalog_tables")
    with pytest.raises(ValueError, match="engine"):
        rename_table(db, "provenance", "prov")
    with pytest.raises(ValueError):
        rename_table(db, "people", "bad name")
    assert execute_sql(db, "SELECT name FROM people") == [{"name": "Ada"}]


def test_rename_table_replays_to_the_hub_and_every_replica(db, hub, tmp_path):
    _mk_estate(db)
    sync(db, hub)
    other = init(tmp_path / "other" / "soma.db")
    sync(other, hub)
    rename_table(db, "people", "humans")
    sync(db, hub)
    sync(other, hub)
    names = {
        r["name"] for r in execute_sql(other, "SELECT name FROM sqlite_master WHERE type='table'")
    }
    assert "humans" in names and "people" not in names
    assert execute_sql(other, "SELECT name FROM humans") == [{"name": "Ada"}]
    assert _live(other, "catalog_properties", tbl="people") == []
    assert {p["id"] for p in _live(other, "catalog_properties", tbl="humans")} == {
        "humans.name",
        "humans.slug",
        "humans.status",
    }
    assert {r["tbl"] for r in execute_sql(other, "SELECT tbl FROM history")} == {"humans"}
    fresh = init(tmp_path / "fresh" / "soma.db")
    sync(fresh, hub)
    assert execute_sql(fresh, "SELECT name FROM humans") == [{"name": "Ada"}]
    # an edit on the renamed table round-trips with its history
    execute_sql(other, "UPDATE humans SET status = 'new' WHERE id = 'a1'")
    sync(other, hub)
    sync(db, hub)
    assert execute_sql(db, "SELECT status FROM humans")[0]["status"] == "new"
    assert len(execute_sql(db, "SELECT * FROM history WHERE tbl = 'humans'")) == 2


def test_sql_rename_table_is_refused(db):
    _mk_people(db, ["Ada"])
    with pytest.raises(ValueError, match="soma table rename"):
        execute_sql(db, "ALTER TABLE people RENAME TO humans")
    with pytest.raises(ValueError, match="soma table rename"):
        execute_sql(db, "alter table people rename to humans")
    assert execute_sql(db, "SELECT name FROM people") == [{"name": "Ada"}]


def test_cli_table_rename(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("SOMA_DATA_DIR", str(tmp_path))
    assert main(["init"]) == 0
    assert main(["table", "create", "pets", "name:text"]) == 0
    assert main(["table", "rename", "pets", "animals"]) == 0
    assert "renamed pets -> animals" in capsys.readouterr().out
    assert main(["sql", "ALTER TABLE animals RENAME TO x"]) == 1
    assert "soma table rename" in capsys.readouterr().err
    assert main(["sql", "SELECT count(*) AS n FROM animals"]) == 0


# --- daemon hygiene ---------------------------------------------------------


def test_with_connect_closes_the_connection_under_a_small_fd_limit(db):
    """sqlite3 connections sit in a reference cycle (statement cache), so an
    un-closed one lives until the cyclic GC runs. launchd caps a daemon at
    256 files; a sync opens far more connections than that, and the daemon
    died with 'unable to open database file' thousands of times."""
    import gc
    import resource

    _mk_people(db, ["Ada"])
    soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
    gc.disable()
    try:
        resource.setrlimit(resource.RLIMIT_NOFILE, (64, hard))
        for _ in range(300):
            execute_sql(db, "SELECT name FROM people")
            db_version(db)
    finally:
        resource.setrlimit(resource.RLIMIT_NOFILE, (soft, hard))
        gc.enable()


def test_watch_survives_a_sync_crash(db, hub, monkeypatch, capsys):
    def boom(path, hub):
        raise sqlite3.OperationalError("unable to open database file")

    monkeypatch.setattr("soma.sync", boom)
    _mk_people(db, ["Ada"])
    watch(db, hub, once=True)  # must not raise: a launchd restart costs a credential read
    assert "sync deferred" in capsys.readouterr().err


@pytest.mark.parametrize("target", ["replica", "hub"])
def test_schema_replay_absent_view_drop_then_replacement(db, tmp_path, target):
    from soma import _apply_local_ddl

    entries = [
        {"applied_at": "2026-01-01T00:00:00.000Z", "ddl": ddl}
        for ddl in ['DROP VIEW "rollup"', 'CREATE VIEW "rollup" AS SELECT 42 AS total']
    ]
    if target == "hub":
        hub = LocalHub(tmp_path / "hub.db")
        hub.ensure_ready()
        assert hub.schema_push(entries) == 2
        assert hub.schema_push(entries) == 0
        assert hub._query("SELECT * FROM rollup") == [{"total": 42}]
    else:
        for entry in entries:
            _apply_local_ddl(db, entry)
        assert execute_sql(db, "SELECT * FROM rollup") == [{"total": 42}]
        assert all(
            entry["ddl"] in {r["ddl"] for r in execute_sql(db, "SELECT ddl FROM _schema_log")}
            for entry in entries
        )
