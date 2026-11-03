import pytest

import soma
from soma import catalog


@pytest.fixture
def db(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "isolated"))
    path = soma.init(tmp_path / "db.sqlite")
    soma.create_table(path, "items", ["name:text!", "status:select!(Open|Closed)"])
    soma.create_table(path, "unrelated", ["payload:text"])
    soma.insert_rows(path, "items", [{"id": "i", "name": "Initial", "status": "Open"}])
    soma.insert_rows(path, "unrelated", [{"id": str(i), "payload": "x" * 100} for i in range(100)])
    return path


def trace(monkeypatch):
    statements = []
    original = soma.connect

    def recorded(*args, **kwargs):
        conn = original(*args, **kwargs)
        conn.set_trace_callback(statements.append)
        return conn

    monkeypatch.setattr(soma, "connect", recorded)
    return statements


def snapshots(statements):
    return [s for s in statements if s.startswith("CREATE TEMP TABLE temp.") and "_before_" in s]


def test_unrelated_table_is_never_snapshotted_for_single_sql_update(db, monkeypatch):
    statements = trace(monkeypatch)
    soma.execute_sql(db, "UPDATE items SET name='Changed' WHERE id='i'")
    assert not any('"_before_unrelated"' in s for s in snapshots(statements))
    assert any('"_before_items"' in s for s in snapshots(statements))
    assert soma.execute_sql(db, "SELECT name FROM items") == [{"name": "Changed"}]
    assert soma.execute_sql(
        db, "SELECT col,old,new FROM history WHERE tbl='items' AND col='name'"
    ) == [{"col": "name", "old": "Initial", "new": "Changed"}]


def test_trigger_mutations_still_validate_and_roll_back_both_tables(db):
    catalog.set_property(db, "unrelated", "payload", type="select", options=[{"v": "Valid"}])
    soma.execute_sql(
        db,
        "CREATE TRIGGER bad_side_effect AFTER UPDATE ON items BEGIN UPDATE unrelated SET payload='Invalid'; END",
    )
    with pytest.raises(catalog.ValidationError):
        soma.execute_sql(db, "UPDATE items SET name='Changed' WHERE id='i'")
    assert soma.execute_sql(db, "SELECT name FROM items") == [{"name": "Initial"}]
    assert soma.execute_sql(db, "SELECT count(*) n FROM history WHERE tbl='items'") == [{"n": 0}]


def test_instead_of_trigger_discovers_underlying_target(db):
    soma.execute_sql(db, "CREATE VIEW item_view AS SELECT id,name FROM items")
    soma.execute_sql(
        db,
        "CREATE TRIGGER view_write INSTEAD OF UPDATE ON item_view BEGIN UPDATE items SET status=NEW.name WHERE id=NEW.id; END",
    )
    with pytest.raises(catalog.ValidationError):
        soma.execute_sql(db, "UPDATE item_view SET name='Invalid' WHERE id='i'")
    assert soma.execute_sql(db, "SELECT status FROM items") == [{"status": "Open"}]


def test_before_changed_and_cross_table_rule_keep_their_semantics(db):
    catalog.set_rule(
        db,
        "transition",
        scope="table",
        tbl="items",
        kind="invariant",
        enforce=1,
        sql="SELECT c.id FROM changed c JOIN before b ON b.id=c.id WHERE c.status='Closed' AND b.status='Open' AND EXISTS (SELECT 1 FROM unrelated)",
        text="Transition needs review",
    )
    with pytest.raises(catalog.ValidationError):
        soma.execute_sql(db, "UPDATE items SET status='Closed' WHERE id='i'")
    assert soma.execute_sql(db, "SELECT status FROM items") == [{"status": "Open"}]


def test_reference_and_derived_user_field_protections_remain(db):
    soma.create_table(db, "links", ["target:ref"])
    catalog.set_property(db, "links", "target", type="ref", ref_table="items")
    with pytest.raises(catalog.ValidationError):
        soma.execute_sql(db, "INSERT INTO links(id,target) VALUES('bad','absent')")
    catalog.set_property(db, "items", "name", derived_by="http:provider", inputs=["id"])
    with pytest.raises(catalog.ValidationError):
        soma.execute_sql(db, "UPDATE items SET name='Forged' WHERE id='i'")
    assert soma.execute_sql(db, "SELECT name FROM items") == [{"name": "Initial"}]


def test_unplanned_callbacks_retain_full_snapshot_fallback(db, monkeypatch):
    statements = trace(monkeypatch)
    catalog.write(db, lambda c: c.execute("UPDATE items SET name='Callback' WHERE id='i'"))
    assert any('"_before_unrelated"' in s for s in snapshots(statements))


def test_raw_catalog_metadata_still_runs_enforced_invariants(db):
    catalog.set_rule(
        db,
        "catalog-label",
        scope="table",
        tbl="catalog_properties",
        kind="invariant",
        enforce=1,
        sql="SELECT id FROM changed WHERE label='Forbidden'",
        text="Forbidden label",
    )
    with pytest.raises(catalog.ValidationError):
        soma.execute_sql(
            db, "UPDATE catalog_properties SET label='Forbidden' WHERE id='items.name'"
        )
    assert soma.execute_sql(db, "SELECT label FROM catalog_properties WHERE id='items.name'") == [
        {"label": None}
    ]


def test_claimed_statement_cannot_hide_an_extra_callback_write(db):
    import sqlite3

    def unexpected(conn):
        conn.execute("UPDATE items SET name='Changed' WHERE id='i'")
        conn.execute("UPDATE unrelated SET payload='Hidden'")

    with pytest.raises(sqlite3.DatabaseError):
        catalog.write(db, unexpected, statement="UPDATE items SET name='Changed' WHERE id='i'")
    assert soma.execute_sql(db, "SELECT name FROM items") == [{"name": "Initial"}]
    assert soma.execute_sql(db, "SELECT count(*) n FROM unrelated WHERE payload='Hidden'") == [
        {"n": 0}
    ]


def test_catalog_and_ddl_paths_keep_full_snapshot_fallback(db, monkeypatch):
    statements = trace(monkeypatch)
    soma.execute_sql(db, "UPDATE catalog_properties SET label='Display' WHERE id='items.name'")
    assert any('"_before_unrelated"' in s for s in snapshots(statements))
    statements.clear()
    soma.execute_sql(db, "ALTER TABLE items ADD COLUMN optional TEXT")
    assert any('"_before_unrelated"' in s for s in snapshots(statements))


def test_fk_cascade_target_invariant_is_not_skipped(db):
    soma.execute_sql(
        db,
        "CREATE TABLE child (id TEXT PRIMARY KEY,parent_id TEXT REFERENCES items(id) ON UPDATE CASCADE,updated_at TEXT,deleted_at TEXT)",
    )
    soma.execute_sql(db, "INSERT INTO child VALUES('child','i','2020-01-01',NULL)")
    catalog.set_rule(
        db,
        "child-parent",
        scope="table",
        tbl="child",
        kind="invariant",
        enforce=1,
        sql="SELECT id FROM changed WHERE parent_id='new'",
        text="Forbidden parent",
    )
    with pytest.raises(catalog.ValidationError):
        soma.execute_sql(db, "UPDATE items SET id='new' WHERE id='i'")
    assert soma.execute_sql(db, "SELECT parent_id FROM child") == [{"parent_id": "i"}]
    assert soma.execute_sql(db, "SELECT id FROM items") == [{"id": "i"}]


def test_read_only_cte_needs_no_table_snapshots(db, monkeypatch):
    statements = trace(monkeypatch)
    assert soma.execute_sql(db, "WITH chosen AS (SELECT name FROM items) SELECT * FROM chosen") == [
        {"name": "Initial"}
    ]
    assert snapshots(statements) == []


def test_dynamic_option_reads_and_immutable_fields_keep_validation(db):
    soma.create_table(db, "choices", ["value:text!"])
    soma.insert_rows(db, "choices", [{"id": "choice", "value": "Allowed"}])
    soma.create_table(db, "entries", ["choice:select", "fixed:text"])
    catalog.set_property(
        db, "entries", "choice", options_sql="SELECT value FROM choices WHERE deleted_at IS NULL"
    )
    catalog.set_property(db, "entries", "fixed", immutable=1)
    soma.execute_sql(db, "INSERT INTO entries(id,choice,fixed) VALUES('entry','Allowed','Initial')")
    with pytest.raises(catalog.ValidationError):
        soma.execute_sql(db, "UPDATE entries SET choice='Unknown' WHERE id='entry'")
    with pytest.raises(catalog.ValidationError):
        soma.execute_sql(db, "UPDATE entries SET fixed='Changed' WHERE id='entry'")
    assert soma.execute_sql(db, "SELECT choice,fixed FROM entries") == [
        {"choice": "Allowed", "fixed": "Initial"}
    ]


def test_declared_write_cannot_forge_temporary_before_images(db):
    import sqlite3

    def forged(conn):
        conn.execute("UPDATE items SET status='Forbidden' WHERE id='i'")
        conn.execute(
            "UPDATE temp._before_items SET status=(SELECT status FROM items WHERE id='i'),updated_at=(SELECT updated_at FROM items WHERE id='i') WHERE id='i'"
        )

    with pytest.raises(sqlite3.DatabaseError):
        catalog.write(db, forged, statement="UPDATE items SET status='Closed' WHERE id='i'")
    assert soma.execute_sql(db, "SELECT status FROM items") == [{"status": "Open"}]
    assert soma.execute_sql(db, "SELECT count(*) n FROM history WHERE tbl='items'") == [{"n": 0}]


def test_unknown_statement_compilation_uses_full_validated_fallback(db, monkeypatch):
    statements = trace(monkeypatch)
    catalog.write(
        db,
        lambda c: c.execute("UPDATE items SET name='Fallback' WHERE id='i'"),
        statement="UPDATE nonexistent SET value=1",
    )
    assert any('"_before_unrelated"' in s for s in snapshots(statements))
    assert soma.execute_sql(db, "SELECT name FROM items") == [{"name": "Fallback"}]
    assert soma.execute_sql(db, "SELECT old,new FROM history WHERE tbl='items' AND col='name'") == [
        {"old": "Initial", "new": "Fallback"}
    ]
