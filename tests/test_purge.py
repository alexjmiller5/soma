"""`soma purge`: a content-free marker that syncs like a row and makes the hub
and every replica hard-delete a row (or one column's history) for good."""

import json

import pytest

import soma
from soma import create_table, execute_sql, init, insert_rows, purge

OLD = "2000-01-01T00:00:00.000Z"
FUTURE = "2099-01-01T00:00:00.000Z"


def _rows(path, table, row_id="r1"):
    return execute_sql(path, f"SELECT * FROM {table} WHERE id = '{row_id}'")


def _history(path, row_id="r1", col=None):
    sql = f"SELECT * FROM history WHERE tbl = 'items' AND row_id = '{row_id}'"
    if col:
        sql += f" AND col = '{col}'"
    return execute_sql(path, sql)


def _edges(path, row_id="r1"):
    return execute_sql(
        path, f"SELECT * FROM provenance WHERE to_kind = 'items' AND to_ref = '{row_id}'"
    )


def _seed(path):
    create_table(path, "items", ["name:text", "note:text"])
    insert_rows(path, "items", [{"id": "r1", "name": "secret", "note": "n0"}])
    execute_sql(path, "UPDATE items SET name = 'more secret', note = 'n1' WHERE id = 'r1'")
    insert_rows(
        path,
        "provenance",
        [
            {
                "id": "manual:x:r1",
                "from_kind": "manual",
                "from_ref": "x",
                "to_kind": "items",
                "to_ref": "r1",
                "rel": "evidence_of",
                "asserted_by": "test",
            }
        ],
    )


@pytest.fixture()
def db(tmp_path):
    path = init(tmp_path / "a.db")
    _seed(path)
    return path


@pytest.fixture()
def pair(tmp_path):
    """Two replicas that share one hub and hold the same secret row."""
    a = init(tmp_path / "a.db")
    _seed(a)
    hub = soma.LocalHub(tmp_path / "hub.db")
    b = init(tmp_path / "b.db")
    assert not soma.sync(a, hub)["rejected"]
    assert not soma.sync(b, hub)["rejected"]
    assert _rows(b, "items") and _history(b)
    return a, b, hub


def test_purge_row_deletes_row_history_and_edges_and_leaves_a_contentless_marker(db):
    assert purge(db, "items", "r1") == {"markers": 1}
    assert _rows(db, "items") == []
    assert _history(db) == []
    assert _edges(db) == []
    [marker] = execute_sql(db, "SELECT * FROM purges")
    assert (marker["tbl"], marker["row_id"], marker["col"]) == ("items", "r1", None)
    assert "secret" not in json.dumps(marker)


def test_purge_column_deletes_only_that_columns_history(db):
    assert purge(db, "items", "r1", cols=["name"]) == {"markers": 1}
    assert _rows(db, "items"), "a column purge keeps the row"
    assert _history(db, col="name") == []
    assert _history(db, col="note"), "other columns keep their history"


def test_purging_again_keeps_one_marker_and_removes_a_recreated_row(db, monkeypatch):
    ticks = ["2030-01-01T00:00:00.000Z"]
    real = soma.connect

    def clocked(path, manual_tx=False):
        conn = real(path, manual_tx)
        conn.create_function("strftime", 2, lambda *_: ticks[0])
        return conn

    monkeypatch.setattr(soma, "connect", clocked)
    purge(db, "items", "r1")
    with real(db) as conn:  # a source re-import lands after the first purge
        conn.execute(
            "INSERT INTO items (id, name, updated_at) "
            "VALUES ('r1', 're-imported', '2030-01-01T00:00:01.000Z')"
        )
    ticks[0] = "2030-01-01T00:00:02.000Z"
    assert purge(db, "items", "r1") == {"markers": 1}
    assert _rows(db, "items") == []
    [marker] = execute_sql(db, "SELECT * FROM purges")
    assert marker["purged_at"] == ticks[0]


@pytest.mark.parametrize("table", ["history", "purges", "catalog_properties", "_sync_state"])
def test_purge_refuses_engine_tables(db, table):
    with pytest.raises(ValueError, match="engine table"):
        purge(db, table, "r1")


def test_purge_refuses_unknown_table_and_column(db):
    with pytest.raises(ValueError, match="no such table"):
        purge(db, "nope", "r1")
    with pytest.raises(ValueError, match="no such column"):
        purge(db, "items", "r1", cols=["nope"])


def test_purge_reaches_the_hub_and_the_other_replica(pair):
    a, b, hub = pair
    purge(a, "items", "r1")
    assert not soma.sync(a, hub)["rejected"]
    assert _rows(hub.path, "items") == []
    assert _history(hub.path) == []
    assert _edges(hub.path) == []
    assert not soma.sync(b, hub)["rejected"]
    assert _rows(b, "items") == []
    assert _history(b) == []
    assert _edges(b) == []


def test_column_purge_reaches_the_hub_and_the_other_replica(pair):
    a, b, hub = pair
    purge(a, "items", "r1", cols=["name"])
    soma.sync(a, hub)
    soma.sync(b, hub)
    for path in (hub.path, b):
        assert _rows(path, "items")
        assert _history(path, col="name") == []
        assert _history(path, col="note")


def test_a_stale_replica_cannot_bring_a_purged_row_back(pair):
    a, b, hub = pair
    # B edits the row while it has not heard of the purge yet
    execute_sql(b, "UPDATE items SET name = 'edited offline' WHERE id = 'r1'")
    purge(a, "items", "r1")
    soma.sync(a, hub)
    assert not soma.sync(b, hub)["rejected"]
    for path in (hub.path, b):
        assert _rows(path, "items") == []
        assert _history(path) == []


def test_the_hub_drops_old_copies_pushed_by_an_unupgraded_client(pair):
    a, _, hub = pair
    purge(a, "items", "r1")
    soma.sync(a, hub)
    out = hub.rows_push(
        "items", ["id", "name", "updated_at"], [{"id": "r1", "name": "x", "updated_at": OLD}]
    )
    assert out["rejected"] == [], "dropping is silent: a rejection would pin the push cursor"
    event = {
        "id": "e1",
        "tbl": "items",
        "row_id": "r1",
        "col": "name",
        "old": "a",
        "new": "b",
        "origin": "old-mac",
        "created_at": OLD,
        "updated_at": OLD,
    }
    out = hub.rows_push("history", list(event), [event])
    assert out["rejected"] == []
    assert _rows(hub.path, "items") == []
    assert _history(hub.path) == []


def test_a_row_recreated_after_the_purge_is_accepted(pair):
    a, _, hub = pair
    purge(a, "items", "r1")
    soma.sync(a, hub)
    out = hub.rows_push(
        "items", ["id", "name", "updated_at"], [{"id": "r1", "name": "new", "updated_at": FUTURE}]
    )
    assert out["upserted"] == 1
    assert _rows(hub.path, "items")[0]["name"] == "new"


def test_cli_purge(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("SOMA_DATA_DIR", str(tmp_path))
    path = init(tmp_path / "soma.db")
    _seed(path)
    assert soma.main(["purge", "items", "r1", "--col", "name"]) == 0
    assert _history(path, col="name") == []
    assert soma.main(["purge", "items", "r1"]) == 0
    assert _rows(path, "items") == []
    assert json.loads(capsys.readouterr().out.strip().splitlines()[-1]) == {"markers": 1}


def test_a_replica_does_not_send_covered_copies(pair):
    a, b, hub = pair
    execute_sql(b, "UPDATE items SET name = 'edited offline' WHERE id = 'r1'")
    purge(a, "items", "r1")
    soma.sync(a, hub)
    sent = []
    push = hub.rows_push

    def spy(table, columns, rows, **kw):
        sent.extend((table, r) for r in rows)
        sent.extend(("history", e) for e in kw.get("history") or [])
        return push(table, columns, rows, **kw)

    hub.rows_push = spy
    soma.sync(b, hub)
    assert not [r for t, r in sent if t == "items" and r["id"] == "r1"]
    assert not [e for t, e in sent if t == "history" and e.get("row_id") == "r1"]


def test_the_hub_drops_covered_history_attached_to_a_newer_push(pair):
    a, _, hub = pair
    purge(a, "items", "r1")
    soma.sync(a, hub)
    event = {
        "id": "e-old",
        "tbl": "items",
        "row_id": "r1",
        "col": "name",
        "old": "secret",
        "new": "x",
        "origin": "old-mac",
        "created_at": OLD,
        "updated_at": OLD,
    }
    hub.rows_push(
        "items",
        ["id", "name", "updated_at"],
        [{"id": "r1", "name": "x", "updated_at": FUTURE}],
        history=[event],
    )
    assert not execute_sql(hub.path, "SELECT * FROM history WHERE id = 'e-old'")


def test_purge_repairs_an_interrupted_setup(db):
    # a first purge stopped after CREATE TABLE (e.g. the database was locked)
    ddl, trigger = soma.table_ddl("purges", soma.PURGE_COLUMNS)
    execute_sql(db, ddl)
    purge(db, "items", "r1")
    names = {r["name"] for r in execute_sql(db, "SELECT name FROM sqlite_master")}
    assert "purges_updated_at" in names
    logged = [r["ddl"] for r in execute_sql(db, "SELECT ddl FROM _schema_log")]
    assert trigger in logged, "the trigger must replay to the hub and replicas"
    assert execute_sql(db, "SELECT 1 FROM catalog_tables WHERE id = 'purges'")
    assert len(execute_sql(db, "SELECT 1 FROM catalog_properties WHERE tbl = 'purges'")) == 4


def test_a_redaction_synced_with_its_marker_leaves_no_old_value_anywhere(pair):
    a, b, hub = pair
    execute_sql(a, "UPDATE items SET name = '[redacted]' WHERE id = 'r1'")
    purge(a, "items", "r1", cols=["name"])
    assert not soma.sync(a, hub)["rejected"]
    assert not soma.sync(b, hub)["rejected"]
    for path in (a, hub.path, b):
        [m] = execute_sql(path, "SELECT purged_at FROM purges")
        old = execute_sql(
            path,
            "SELECT * FROM history WHERE tbl = 'items' AND row_id = 'r1' AND col = 'name' "
            f"AND created_at <= '{m['purged_at']}'",
        )
        assert old == [], path
        assert "secret" not in json.dumps(execute_sql(path, "SELECT * FROM history"))


def test_a_replica_does_not_take_covered_copies_from_the_hub(pair):
    a, b, hub = pair
    purge(a, "items", "r1")
    soma.sync(a, hub)
    soma.sync(b, hub)
    # a hub that never applied the marker still serves the old row and event
    with soma.connect(hub.path) as conn:
        conn.execute(
            "INSERT INTO items (id, name, updated_at, hub_at) "
            f"VALUES ('r1', 'secret', '{OLD}', '{FUTURE}')"
        )
        conn.execute(
            "INSERT INTO history (id, tbl, row_id, col, old, new, created_at, updated_at, hub_at) "
            f"VALUES ('h-stale', 'items', 'r1', 'name', 'a', 'secret', '{OLD}', '{OLD}', '{FUTURE}')"
        )
    soma.sync(b, hub)
    assert _rows(b, "items") == []
    assert _history(b) == []


def test_purge_provenance_removes_edge_and_its_history_on_every_replica(pair):
    a, b, hub = pair
    execute_sql(
        a, "UPDATE provenance SET detail = '{\"value\":\"private\"}' WHERE id = 'manual:x:r1'"
    )
    assert not soma.sync(a, hub)["rejected"]
    assert not soma.sync(b, hub)["rejected"]
    assert purge(a, "provenance", "manual:x:r1") == {"markers": 1}
    assert not soma.sync(a, hub)["rejected"]
    assert not soma.sync(b, hub)["rejected"]
    for path in (a, b, hub.path):
        assert _rows(path, "provenance", "manual:x:r1") == []
        assert (
            execute_sql(
                path, "SELECT id FROM history WHERE tbl='provenance' AND row_id='manual:x:r1'"
            )
            == []
        )
        assert _rows(path, "items"), "Purging evidence preserves its subject"


def _seed_bulk(path):
    insert_rows(
        path,
        "items",
        [{"id": "r2", "name": "original", "note": "old"}, {"id": "keep", "name": "keep"}],
    )
    execute_sql(path, "UPDATE items SET name='changed', note='new' WHERE id='r2'")
    insert_rows(
        path,
        "provenance",
        [
            {
                "id": "manual:y:r2",
                "from_kind": "manual",
                "from_ref": "y",
                "to_kind": "items",
                "to_ref": "r2",
                "rel": "evidence_of",
                "asserted_by": "test",
            }
        ],
    )


def test_cli_bulk_purge_reuses_row_semantics_and_deduplicates_ids(db, monkeypatch, capsys):
    _seed_bulk(db)
    monkeypatch.setenv("SOMA_DATA_DIR", str(db.parent))
    db.rename(db.parent / "soma.db")
    path = db.parent / "soma.db"
    assert soma.main(["purge", "items", "r1", "r2", "r1"]) == 0
    assert json.loads(capsys.readouterr().out) == {"markers": 2}
    assert execute_sql(path, "SELECT id FROM items") == [{"id": "keep"}]
    assert execute_sql(path, "SELECT id FROM history WHERE tbl='items'") == []
    assert execute_sql(path, "SELECT id FROM provenance") == []
    assert len(execute_sql(path, "SELECT DISTINCT purged_at FROM purges")) == 1
    assert {r["row_id"] for r in execute_sql(path, "SELECT row_id FROM purges")} == {"r1", "r2"}
    assert {
        r["row_id"] for r in execute_sql(path, "SELECT row_id FROM _sync_dirty WHERE tbl='purges'")
    } == {'["items", "r1", null]', '["items", "r2", null]'}


@pytest.mark.parametrize("cols", [["name"], ["name", "note"]])
def test_bulk_column_purge_keeps_live_rows_and_unrelated_history(db, cols):
    _seed_bulk(db)
    assert purge(db, "items", ["r1", "r2"], cols=cols) == {"markers": 2 * len(cols)}
    for rid in ["r1", "r2"]:
        assert _rows(db, "items", rid)
        assert _edges(db, rid)
        assert _history(db, rid, "name") == []
        assert bool(_history(db, rid, "note")) == ("note" not in cols)


@pytest.mark.parametrize("ids", [[], ["r1", ""], ["r1", None]])
def test_bulk_purge_preflights_every_id_before_writing(db, ids):
    with pytest.raises(ValueError, match="row id"):
        purge(db, "items", ids)
    assert _rows(db, "items")
    assert not execute_sql(db, "SELECT name FROM sqlite_master WHERE name='purges'")


def test_bulk_purge_rolls_back_markers_and_all_cleanup_on_failure(db):
    _seed_bulk(db)
    with soma.connect(db) as conn:
        conn.execute(
            "CREATE TRIGGER block_second BEFORE DELETE ON items WHEN OLD.id='r2' BEGIN SELECT RAISE(ABORT,'blocked purge'); END"
        )
    with pytest.raises(soma.sqlite3.IntegrityError, match="blocked purge"):
        purge(db, "items", ["r1", "r2"])
    for rid in ["r1", "r2"]:
        assert _rows(db, "items", rid)
        assert _history(db, rid)
        assert _edges(db, rid)
    assert execute_sql(db, "SELECT * FROM purges") == []


def test_bulk_purge_reaches_hub_and_other_replica(pair):
    a, b, hub = pair
    _seed_bulk(a)
    assert not soma.sync(a, hub)["rejected"]
    assert not soma.sync(b, hub)["rejected"]
    assert purge(a, "items", ["r1", "r2"]) == {"markers": 2}
    assert not soma.sync(a, hub)["rejected"]
    assert not soma.sync(b, hub)["rejected"]
    for path in (a, hub.path, b):
        assert execute_sql(path, "SELECT id FROM items") == [{"id": "keep"}]
        assert execute_sql(path, "SELECT id FROM history WHERE tbl='items'") == []
        assert execute_sql(path, "SELECT id FROM provenance") == []
