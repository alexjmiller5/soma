import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

from soma import connect, create_table, execute_sql, init, insert_rows, rename_column
from soma.catalog import (
    ValidationError,
    Violation,
    audit,
    check,
    check_rule_sql,
    doc,
    ensure_catalog,
    has_catalog,
    infer,
    inputs_hash,
    properties,
    rm_property,
    rm_rule,
    rules,
    run_invariant,
    set_property,
    set_rule,
    set_table,
    validate_push,
    validate_row,
    value_hash,
    write,
)


@pytest.fixture()
def db(tmp_path):
    return init(tmp_path / "soma.db")


def test_cli_writer_waits_until_another_validation_snapshot_commits(db):
    create_table(db, "items", ["name:text!"])
    child = None

    def first_writer(conn):
        nonlocal child
        child = subprocess.Popen(
            [
                sys.executable,
                "-c",
                (
                    "from soma import main; print('ready', flush=True); "
                    "main(['sql', \"INSERT INTO items (id,name) VALUES ('second','Second')\"])"
                ),
            ],
            env={
                "PATH": os.environ["PATH"],
                "SOMA_DATA_DIR": str(db.parent),
                "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src"),
            },
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        assert child.stdout.readline().strip() == "ready"
        with pytest.raises(subprocess.TimeoutExpired):
            child.communicate(timeout=5.5)
        conn.execute("INSERT INTO items (id,name) VALUES ('first','First')")

    try:
        write(db, first_writer)
        _, stderr = child.communicate(timeout=10)
        assert child.returncode == 0, stderr
        assert execute_sql(db, "SELECT name FROM items ORDER BY id") == [
            {"name": "First"},
            {"name": "Second"},
        ]
    finally:
        if child is not None and child.poll() is None:
            child.kill()
            child.communicate()


def test_ensure_catalog_creates_logged_tables(db):
    ensure_catalog(db)
    names = {
        r["name"] for r in execute_sql(db, "SELECT name FROM sqlite_master WHERE type='table'")
    }
    assert {
        "catalog_tables",
        "catalog_properties",
        "catalog_rules",
        "provenance",
        "catalog_log",
    } <= names
    ddls = [r["ddl"] for r in execute_sql(db, "SELECT ddl FROM _schema_log")]
    assert any("catalog_properties" in d for d in ddls)
    ensure_catalog(db)  # idempotent
    assert len([d for d in ddls if 'CREATE TABLE "catalog_properties"' in d]) == 1


def test_ensure_catalog_creates_engine_indexes_unlogged(db):
    ensure_catalog(db)
    indexes = {
        r["name"] for r in execute_sql(db, "SELECT name FROM sqlite_master WHERE type='index'")
    }
    assert {"provenance_to", "provenance_from"} <= indexes
    assert not any(
        "INDEX" in r["ddl"].upper() for r in execute_sql(db, "SELECT ddl FROM _schema_log")
    )
    ensure_catalog(db)  # idempotent
    plan = execute_sql(
        db,
        "EXPLAIN QUERY PLAN SELECT 1 FROM provenance WHERE to_kind = 'x' AND to_ref = 'y'",
    )
    assert any("provenance_to" in r["detail"] for r in plan)


def test_has_catalog_false_on_fresh_db(db):
    with connect(db) as conn:
        assert has_catalog(conn) is False
    ensure_catalog(db)
    with connect(db) as conn:
        assert has_catalog(conn) is True


def test_set_property_upserts_and_parses(db):
    set_property(
        db,
        "places",
        "status",
        type="select",
        required=1,
        options=[{"v": "want"}, {"v": "been", "d": "confirmed"}],
    )
    set_property(db, "places", "status", description="lowercase")
    with connect(db) as conn:
        props = properties(conn, "places")
    assert len(props) == 1
    p = props[0]
    assert p["id"] == "places.status" and p["type"] == "select" and p["required"] == 1
    assert p["options"][1] == {"v": "been", "d": "confirmed"}
    assert p["description"] == "lowercase"


def test_set_property_rejects_unknown_type(db):
    with pytest.raises(ValueError, match="type"):
        set_property(db, "places", "x", type="blob")


def test_rm_property_soft_deletes(db):
    set_property(db, "places", "status", type="text")
    rm_property(db, "places", "status")
    with connect(db) as conn:
        assert properties(conn, "places") == []
    row = execute_sql(db, "SELECT deleted_at FROM catalog_properties WHERE id='places.status'")[0]
    assert row["deleted_at"] is not None


def test_set_rule_and_set_table(db):
    set_rule(db, "estate-soft-delete", scope="estate", kind="doctrine", text="soft delete only")
    set_table(db, "places", kind="table", purpose="somewhere real")
    with connect(db) as conn:
        assert rules(conn, kind="doctrine")[0]["id"] == "estate-soft-delete"
    t = execute_sql(db, "SELECT purpose FROM catalog_tables WHERE id='places'")[0]
    assert t["purpose"] == "somewhere real"


def test_set_rule_with_no_fields_revives_existing_row(db):
    set_rule(db, "r1", scope="estate", kind="doctrine", text="x")
    rm_rule(db, "r1")
    set_rule(db, "r1")
    with connect(db) as conn:
        revived = rules(conn)[0]
    assert revived["id"] == "r1" and revived["text"] == "x"
    log = execute_sql(db, "SELECT action FROM catalog_log WHERE row_id = 'r1' ORDER BY created_at")
    assert log[-1]["action"] == "set"


def test_catalog_writes_are_logged(db):
    set_property(db, "places", "status", type="text")
    set_rule(db, "r1", scope="estate", kind="doctrine", text="x")
    log = execute_sql(
        db,
        "SELECT tbl, row_id, action FROM catalog_log WHERE row_id IN ('places.status', 'r1') ORDER BY created_at",
    )
    assert log[0] == {"tbl": "catalog_properties", "row_id": "places.status", "action": "set"}
    assert log[1] == {"tbl": "catalog_rules", "row_id": "r1", "action": "set"}


FIXTURE = Path(__file__).parent / "fixtures" / "validation-cases.json"
CASES = json.loads(FIXTURE.read_text())


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_validate_row_conformance(case):
    refs = case.get("refs", {})
    extra = case.get("extra_options", {})
    got = validate_row(
        case["properties"],
        case["before"],
        case["after"],
        in_derive=set(case.get("in_derive", [])),
        ref_ok=lambda t, i: i in refs.get(t, []),
        extra_options=lambda p: extra.get(p["col"], []),
        touched=set(case["touched"]) if case.get("touched") else None,
    )
    assert [{"col": v.col, "rule": v.rule} for v in got] == case["expect"]


def test_violation_message_names_allowed_values():
    props = [
        {"tbl": "t", "col": "status", "type": "select", "options": [{"v": "want"}, {"v": "been"}]}
    ]
    v = validate_row(props, None, {"id": "a", "status": "Been"})[0]
    assert isinstance(v, Violation)
    assert v.tbl == "t" and v.row_id == "a"
    assert "want, been" in v.message


# --- write path ---------------------------------------------------------------


def _places(db):
    create_table(db, "places", ["name:text", "status:text", "tags:text", "gmaps_url:text"])
    set_property(db, "places", "name", type="text", required=1)
    set_property(
        db,
        "places",
        "status",
        type="select",
        required=1,
        default_value="want",
        options=[{"v": "want"}, {"v": "priority"}, {"v": "been"}],
    )
    set_property(db, "places", "tags", type="multi_select", options=[{"v": "bar"}, {"v": "cafe"}])


def test_insert_violation_rolls_back_whole_statement(db):
    _places(db)
    with pytest.raises(ValidationError) as ei:
        insert_rows(
            db, "places", [{"name": "Casa", "status": "want"}, {"name": "Bad", "status": "Been"}]
        )
    assert ei.value.violations[0].col == "status" and ei.value.violations[0].rule == "options"
    assert execute_sql(db, "SELECT count(*) AS n FROM places")[0]["n"] == 0


def test_update_via_sql_is_validated(db):
    _places(db)
    insert_rows(db, "places", [{"name": "Casa", "status": "want"}])
    with pytest.raises(ValidationError, match="not an option"):
        execute_sql(db, "UPDATE places SET status = 'visited'")
    assert execute_sql(db, "SELECT status FROM places")[0]["status"] == "want"


def test_only_changed_rows_are_validated(db):
    create_table(db, "places", ["name:text", "status:text"])
    insert_rows(db, "places", [{"id": "old", "name": "legacy", "status": "Weird"}])
    set_property(db, "places", "status", type="select", options=[{"v": "want"}])
    insert_rows(db, "places", [{"id": "new", "name": "n", "status": "want"}])
    execute_sql(db, "UPDATE places SET name = 'renamed' WHERE id = 'new'")  # legacy row untouched
    assert execute_sql(db, "SELECT name FROM places WHERE id='new'")[0]["name"] == "renamed"
    with pytest.raises(ValidationError):
        execute_sql(
            db, "UPDATE places SET name = 'touch' WHERE id = 'old'"
        )  # touching it forces the fix


def test_untouched_legacy_row_is_not_validated_by_its_timestamp(db):
    """Changed rows come from the snapshot diff, not a timestamp comparison:
    `updated_at >= t0` also catches rows this write never touched whenever the
    clock collides (same millisecond) or a pulled row is dated ahead."""
    create_table(db, "places", ["name:text", "status:text"])
    insert_rows(db, "places", [{"id": "old", "name": "legacy", "status": "Weird"}])
    set_property(db, "places", "status", type="select", options=[{"v": "want"}])
    conn = connect(db)  # a replica pull lands rows without re-validating them
    conn.execute("UPDATE places SET updated_at = '2099-01-01T00:00:00.000Z' WHERE id = 'old'")
    conn.commit()
    conn.close()
    insert_rows(db, "places", [{"id": "new", "name": "n", "status": "want"}])
    assert execute_sql(db, "SELECT count(*) AS n FROM places")[0]["n"] == 2


def test_change_without_a_timestamp_bump_is_still_validated(db):
    """The other half: a table made by raw `soma sql` has no updated_at
    trigger, so a bad UPDATE moves no timestamp. The snapshot diff sees it."""
    execute_sql(db, "CREATE TABLE t (id TEXT PRIMARY KEY, status TEXT, updated_at TEXT)")
    execute_sql(db, "INSERT INTO t (id, status, updated_at) VALUES ('a','want','2020-01-01')")
    set_property(db, "t", "status", type="select", options=[{"v": "want"}])
    with pytest.raises(ValidationError, match="not an option"):
        execute_sql(db, "UPDATE t SET status = 'Nope'")
    assert execute_sql(db, "SELECT status FROM t")[0]["status"] == "want"


def test_dropping_a_column_is_not_blocked_by_a_legacy_row(db):
    """The snapshot diff must compare the columns the two shapes share: after a
    DROP/RENAME COLUMN, a row whose only difference is that column is unchanged
    and must not be dragged through validation."""
    create_table(db, "places", ["name:text", "status:text", "junk:text"])
    insert_rows(db, "places", [{"id": "old", "name": "legacy", "status": "Weird", "junk": "x"}])
    set_property(db, "places", "status", type="select", options=[{"v": "want"}])
    execute_sql(db, "ALTER TABLE places DROP COLUMN junk")
    rename_column(db, "places", "name", "title")
    cols = {r["name"] for r in execute_sql(db, "PRAGMA table_info(places)")}
    assert "junk" not in cols and "title" in cols
    with pytest.raises(ValidationError):  # touching the row still validates it
        execute_sql(db, "UPDATE places SET title = 'touch' WHERE id = 'old'")


def test_number_inputs_hash_the_same_from_the_table_and_from_a_pushed_row(db):
    """The client hashes the stored REAL (4 -> '4.0'); validate_push hashes the
    pushed JSON 4, which binds as INTEGER. Both must render identically."""
    create_table(db, "t", ["qty:number", "double:number"])
    set_property(db, "t", "qty", type="number")
    set_property(db, "t", "double", type="number", derived_by="http:double", inputs=["qty"])
    insert_rows(db, "t", [{"id": "a", "qty": 4}])
    with connect(db) as conn:
        # provenance as the client writes it: hashed off the stored REALs
        conn.execute("UPDATE t SET double = 8 WHERE id = 'a'")
        conn.execute(
            "INSERT INTO provenance (id, to_kind, to_ref, field, from_kind, from_ref, rel, asserted_by, inputs_hash, value_hash) "
            "VALUES ('t:a:double','t','a','double','http:double','x','derived_from','hub',?,?)",
            (inputs_hash(conn, "t", "a", ["qty"]), value_hash(conn, "t", "a", "double")),
        )
        conn.execute("UPDATE t SET double = NULL WHERE id = 'a'")  # so the push is a change
        conn.commit()
        accepted, rejected = validate_push(conn, "t", [{"id": "a", "qty": 4, "double": 8}])
    assert rejected == []
    assert len(accepted) == 1


def test_validate_push_checks_required_against_the_merged_row(db):
    """A push carries only the columns it writes: required is a property of the
    row as it will be, not of the payload. Insert still demands all of them."""
    create_table(db, "t", ["name:text!", "note:text"])
    insert_rows(db, "t", [{"id": "a", "name": "A"}])
    with connect(db) as conn:
        accepted, rejected = validate_push(conn, "t", [{"id": "a", "note": "hi"}])
        assert rejected == [] and len(accepted) == 1
        _, rejected = validate_push(conn, "t", [{"id": "new", "note": "hi"}])
        assert rejected[0]["rule"] == "required"
        _, rejected = validate_push(conn, "t", [{"id": "a", "name": None}])
        assert rejected[0]["rule"] == "required"


def test_a_partial_local_update_is_validated_as_the_stored_row(db):
    """The local write path reads changed rows back out of the table, so it has
    always seen the merged row - a partial UPDATE never trips `required`."""
    create_table(db, "t", ["name:text!", "note:text"])
    insert_rows(db, "t", [{"id": "a", "name": "A"}])
    execute_sql(db, "UPDATE t SET note = 'hi' WHERE id = 'a'")
    assert execute_sql(db, "SELECT name, note FROM t")[0] == {"name": "A", "note": "hi"}
    with pytest.raises(ValidationError):  # emptying it is still a violation
        execute_sql(db, "UPDATE t SET name = NULL WHERE id = 'a'")


def test_defaults_apply_on_insert(db):
    _places(db)
    insert_rows(db, "places", [{"name": "Casa"}])
    assert execute_sql(db, "SELECT status FROM places")[0]["status"] == "want"


def test_sql_default_is_evaluated(db):
    import re

    create_table(db, "tasks", ["title:text", "due:text"])
    set_property(db, "tasks", "due", type="date", default_value="sql:date('now')")
    insert_rows(db, "tasks", [{"title": "x"}])
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", execute_sql(db, "SELECT due FROM tasks")[0]["due"])


def test_ref_checks_target_table(db):
    create_table(db, "people", ["name:text"])
    insert_rows(db, "people", [{"id": "p1", "name": "Ada"}])
    create_table(db, "links", ["person:text"])
    set_property(db, "links", "person", type="ref", ref_table="people")
    insert_rows(db, "links", [{"person": "p1"}])
    with pytest.raises(ValidationError, match="No people row"):
        insert_rows(db, "links", [{"person": "p9"}])


def test_options_sql_extends_allowlist(db):
    create_table(db, "place_tags", ["name:text"])
    insert_rows(db, "place_tags", [{"name": "sports bar"}])
    create_table(db, "tasks", ["tag:text"])
    set_property(
        db,
        "tasks",
        "tag",
        type="select",
        options=[{"v": "chore"}],
        options_sql="SELECT name FROM place_tags WHERE deleted_at IS NULL",
    )
    insert_rows(db, "tasks", [{"tag": "sports bar"}])
    with pytest.raises(ValidationError):
        insert_rows(db, "tasks", [{"tag": "dive bar"}])


def test_reads_are_not_wrapped(db):
    _places(db)
    assert execute_sql(db, "SELECT 1 AS one") == [{"one": 1}]


def test_uncataloged_table_is_unconstrained(db):
    _places(db)
    create_table(db, "scratch", ["v:text"])
    insert_rows(db, "scratch", [{"v": "anything"}])


def test_engine_tables_are_never_validated_against_themselves(db):
    _places(db)
    set_property(db, "catalog_properties", "type", type="select", options=[{"v": "text"}])
    set_property(
        db, "places", "extra", type="url"
    )  # would fail if catalog_properties were validated


# --- invariants -----------------------------------------------------------


def test_rule_sql_rejects_nondeterminism():
    for bad in ("SELECT random()", "SELECT datetime('now')", "SELECT date('now','localtime')"):
        with pytest.raises(ValueError):
            check_rule_sql(bad)
    check_rule_sql("SELECT id FROM t WHERE x > (SELECT ts FROM now)")


@pytest.mark.parametrize(
    "case",
    json.loads((Path(__file__).parent / "fixtures/rule-sql-cases.json").read_text()),
    ids=lambda case: case["sql"],
)
def test_supported_rule_sql_contract(case):
    if case["allowed"]:
        check_rule_sql(case["sql"])
    else:
        with pytest.raises(ValueError):
            check_rule_sql(case["sql"])


def test_existing_ambient_rule_rolls_back_the_python_write(db):
    create_table(db, "items", ["name:text"])
    insert_rows(db, "items", [{"id": "item-1", "name": "Before"}])
    with connect(db) as conn:
        conn.execute(
            "INSERT INTO catalog_rules (id,tbl,kind,enforce,sql,text) VALUES (?,?,?,?,?,?)",
            (
                "clock-rule",
                "items",
                "invariant",
                1,
                "SELECT id FROM changed WHERE CURRENT_DATE IS NULL",
                "Unsupported rule",
            ),
        )
    with pytest.raises(ValueError, match="rule sql may not"):
        execute_sql(db, "UPDATE items SET name='After' WHERE id='item-1'")
    assert execute_sql(db, "SELECT name FROM items") == [{"name": "Before"}]
    assert execute_sql(db, "SELECT * FROM history WHERE tbl='items'") == []


def test_set_rule_compiles_invariant(db):
    with pytest.raises(ValueError, match="no such table"):
        set_rule(
            db,
            "bad",
            scope="table",
            tbl="places",
            kind="invariant",
            enforce=1,
            sql="SELECT id FROM nope",
        )


def test_enforced_invariant_blocks_write(db):
    create_table(db, "places", ["category:text", "tags:text"])
    set_property(db, "places", "tags", type="multi_select", options=[{"v": "bar"}, {"v": "cafe"}])
    set_property(db, "places", "category", type="select", options=[{"v": "bar"}, {"v": "cafe"}])
    set_rule(
        db,
        "cat-in-tags",
        scope="table",
        tbl="places",
        kind="invariant",
        enforce=1,
        text="Category must be one of the tags.",
        sql="SELECT id FROM places WHERE deleted_at IS NULL AND category IS NOT NULL "
        "AND NOT EXISTS (SELECT 1 FROM json_each(tags) WHERE value = places.category)",
    )
    insert_rows(db, "places", [{"category": "bar", "tags": ["bar"]}])
    with pytest.raises(ValidationError, match="Category must be one of the tags"):
        insert_rows(db, "places", [{"category": "cafe", "tags": ["bar"]}])


def test_unenforced_invariant_does_not_block(db):
    create_table(db, "places", ["category:text", "tags:text"])
    set_property(db, "places", "category", type="text")
    set_rule(
        db,
        "cat-in-tags",
        scope="table",
        tbl="places",
        kind="invariant",
        enforce=0,
        text="x",
        sql="SELECT id FROM places WHERE category = 'zzz'",
    )
    insert_rows(db, "places", [{"category": "zzz", "tags": "[]"}])


def test_transition_rule_uses_before_and_changed(db):
    create_table(db, "places", ["status:text"])
    set_property(db, "places", "status", type="select", options=[{"v": "want"}, {"v": "been"}])
    set_rule(
        db,
        "no-unbeen",
        scope="table",
        tbl="places",
        kind="invariant",
        enforce=1,
        text="A been place never goes back to want.",
        sql="SELECT c.id FROM changed c JOIN before b ON b.id = c.id "
        "WHERE b.status = 'been' AND c.status = 'want'",
    )
    insert_rows(db, "places", [{"id": "x", "status": "want"}])
    execute_sql(db, "UPDATE places SET status = 'been' WHERE id = 'x'")
    with pytest.raises(ValidationError, match="never goes back"):
        execute_sql(db, "UPDATE places SET status = 'want' WHERE id = 'x'")


def test_now_is_injected_not_read(db):
    create_table(db, "tasks", ["due:text"])
    set_property(db, "tasks", "due", type="date")
    set_rule(
        db,
        "not-past",
        scope="table",
        tbl="tasks",
        kind="invariant",
        enforce=0,
        text="due in the past",
        sql="SELECT id FROM tasks WHERE due < substr((SELECT ts FROM now), 1, 10)",
    )
    insert_rows(db, "tasks", [{"id": "a", "due": "2001-01-01"}])
    with connect(db) as conn:
        rule = rules(conn, kind="invariant")[0]
        assert run_invariant(conn, rule, now="2000-01-01T00:00:00.000Z") == []
        assert [r["id"] for r in run_invariant(conn, rule, now="2026-01-01T00:00:00.000Z")] == ["a"]


def test_ddl_recompiles_rules(db):
    create_table(db, "places", ["category:text"])
    set_rule(
        db,
        "r",
        scope="table",
        tbl="places",
        kind="invariant",
        enforce=1,
        text="x",
        sql="SELECT id FROM places WHERE category = 'z'",
    )
    with pytest.raises(ValidationError, match="no longer compiles"):
        execute_sql(db, "ALTER TABLE places DROP COLUMN category")


def test_before_and_changed_share_shape_for_set_ops(db):
    create_table(db, "places", ["status:text"])
    set_property(db, "places", "status", type="text")
    set_rule(
        db,
        "frozen",
        scope="table",
        tbl="places",
        kind="invariant",
        enforce=1,
        text="rows may not change",
        sql="SELECT id FROM (SELECT * FROM before EXCEPT SELECT * FROM changed)",
    )
    insert_rows(db, "places", [{"id": "x", "status": "a"}])
    execute_sql(db, "UPDATE places SET status = 'z' WHERE id = 'nope'")  # touches no row
    with pytest.raises(ValidationError, match="rows may not change"):
        execute_sql(db, "UPDATE places SET status = 'b' WHERE id = 'x'")


def test_dropped_table_recompile_raises_validation_not_sqlite_error(db):
    create_table(db, "places", ["status:text"])
    set_rule(
        db,
        "watch",
        scope="table",
        tbl="places",
        kind="invariant",
        enforce=1,
        text="x",
        sql="SELECT id FROM changed",
    )
    with pytest.raises(ValidationError, match="no longer compiles"):
        execute_sql(db, "DROP TABLE places")


# --- check ------------------------------------------------------------------


def test_check_reports_legacy_violations_and_unenforced_rules(db):
    create_table(db, "places", ["status:text"])
    insert_rows(db, "places", [{"id": "old", "status": "Weird"}])
    set_property(db, "places", "status", type="select", options=[{"v": "want"}])
    set_rule(
        db,
        "r",
        scope="table",
        tbl="places",
        kind="invariant",
        enforce=0,
        text="no old",
        sql="SELECT id FROM places WHERE id = 'old'",
    )
    findings = check(db)
    assert {(f["row_id"], f["rule"]) for f in findings} == {("old", "options"), ("old", "r")}


def test_cli_check_exit_code(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("SOMA_DATA_DIR", str(tmp_path))
    from soma import main

    main(["init"])
    main(["table", "create", "pets", "name:text"])
    assert main(["check"]) == 0
    main(["property", "set", "pets.name", "--type", "select", "--options", "cat,dog"])
    import sqlite3 as s

    s.connect(tmp_path / "soma.db").execute(
        "INSERT INTO pets (name) VALUES ('rat')"
    ).connection.commit()
    capsys.readouterr()  # discard prior commands' stdout; isolate this check's output
    assert main(["check"]) == 1
    assert json.loads(capsys.readouterr().out)[0]["rule"] == "options"


# --- derivations & provenance -------------------------------------------------


def _movies(db):
    create_table(db, "movies", ["title:text", "tmdb_id:text", "genres:text", "slug:text"])
    set_property(db, "movies", "tmdb_id", type="text", required=1)
    set_property(db, "movies", "genres", type="json", derived_by="http:tmdb", inputs=["tmdb_id"])
    set_property(db, "movies", "slug", type="text", derived_by="http:slug", inputs=["title"])


def _record_provenance(db, tbl, row_id, col, inputs):
    """Stand in for the hub's derive engine: write the cell and its provenance
    the way the hub would, so the client-side checks have state to see."""
    with connect(db) as conn:
        conn.execute(
            "INSERT INTO provenance (id, to_kind, to_ref, field, from_kind, from_ref, rel, asserted_by, inputs_hash, value_hash, produced_at) "
            "VALUES (?, ?, ?, ?, 'http:x', 'x', 'derived_from', 'hub', ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
            (
                f"{tbl}:{row_id}:{col}",
                tbl,
                row_id,
                col,
                inputs_hash(conn, tbl, row_id, inputs),
                value_hash(conn, tbl, row_id, col),
            ),
        )


def test_derived_by_must_be_http(db):
    create_table(db, "movies", ["slug:text"])
    with pytest.raises(ValueError, match="http:"):
        set_property(db, "movies", "slug", type="text", derived_by="sql:lower(title)")


def test_derived_column_cannot_be_required(db):
    create_table(db, "movies", ["genres:text"])
    with pytest.raises(ValueError, match="required"):
        set_property(
            db, "movies", "genres", type="json", required=1, derived_by="http:tmdb", inputs=[]
        )


def test_hand_edit_to_derived_column_is_rejected(db):
    _movies(db)
    insert_rows(db, "movies", [{"id": "m1", "title": "x", "tmdb_id": "78"}])
    with pytest.raises(ValidationError, match="derived"):
        execute_sql(db, "UPDATE movies SET slug = 'hand' WHERE id = 'm1'")


def test_check_reports_stale_and_underived(db):
    _movies(db)
    insert_rows(db, "movies", [{"id": "m1", "title": "x", "tmdb_id": "78"}])
    _record_provenance(db, "movies", "m1", "slug", ["title"])
    execute_sql(db, "UPDATE movies SET title = 'y' WHERE id = 'm1'")  # input changed
    rules_hit = {(f["col"], f["rule"]) for f in check(db)}
    assert ("slug", "stale") in rules_hit and ("genres", "underived") in rules_hit


def test_check_counts_a_hub_no_data_proof_as_derived_and_fresh(db):
    """A hub lookup that completed without data for a column writes a no-data
    proof over the value it left in place: not underived, not stale."""
    _movies(db)
    insert_rows(db, "movies", [{"id": "m1", "title": "x", "tmdb_id": "78"}])
    with connect(db) as conn:
        for col, inputs in (("genres", ["tmdb_id"]), ("slug", ["title"])):
            conn.execute(
                "INSERT INTO provenance (id, to_kind, to_ref, field, from_kind, from_ref, rel, asserted_by, detail, inputs_hash, value_hash, produced_at) "
                "VALUES (?, 'movies', 'm1', ?, 'http:x', 'x', 'derived_from', 'hub', '{\"no_data\":true}', ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
                (
                    f"movies:m1:{col}",
                    col,
                    inputs_hash(conn, "movies", "m1", inputs),
                    value_hash(conn, "movies", "m1", col),
                ),
            )
        conn.commit()
    assert [f for f in check(db) if f["col"] in ("genres", "slug")] == []


# --- audit --------------------------------------------------------------------


def test_audit_runs_command_and_reports_findings(db, tmp_path):
    script = tmp_path / "check_tmdb.py"
    script.write_text(
        "import json\nprint(json.dumps([{'tbl':'movies','row_id':'m1','col':'title','message':'not TMDB-exact'}]))\n"
    )
    set_rule(
        db,
        "tmdb-exact",
        scope="table",
        tbl="movies",
        kind="audit",
        cmd="tmdb-exact",
        text="Titles must be TMDB-exact",
    )
    findings = audit(db, commands={"tmdb-exact": f"python3 {script}"})
    assert findings == [
        {
            "tbl": "movies",
            "row_id": "m1",
            "col": "title",
            "rule": "tmdb-exact",
            "message": "not TMDB-exact",
        }
    ]


def test_audit_raises_without_configured_command(db):
    set_rule(
        db, "tmdb-exact", scope="table", tbl="movies", kind="audit", cmd="tmdb-exact", text="x"
    )
    with pytest.raises(RuntimeError, match="no command configured"):
        audit(db)


def test_audit_filters_by_rule_id(db, tmp_path):
    script = tmp_path / "ok.py"
    script.write_text("import json\nprint(json.dumps([]))\n")
    set_rule(db, "a", scope="table", tbl="movies", kind="audit", cmd="a", text="a")
    set_rule(db, "b", scope="table", tbl="movies", kind="audit", cmd="b", text="b")
    assert audit(db, rule_id="a", commands={"a": f"python3 {script}"}) == []


# --- infer ----------------------------------------------------------------


def test_infer_proposes_required_select_date_url_ref(db):
    create_table(db, "people", ["name:text"])
    insert_rows(db, "people", [{"id": f"p{i}", "name": f"n{i}"} for i in range(25)])
    create_table(
        db, "places", ["name:text", "status:text", "went:text", "url:text", "who:text", "tags:text"]
    )
    insert_rows(
        db,
        "places",
        [
            {
                "name": f"x{i}",
                "status": ("want", "been")[i % 2],
                "went": f"2026-01-{i + 1:02d}",
                "url": f"https://maps.app.goo.gl/{i}",
                "who": f"p{i}",
                "tags": ["bar"] if i % 3 else ["cafe"],
            }
            for i in range(25)
        ],
    )
    props = {p["col"]: p for p in infer(db, "places")}
    assert props["name"]["required"] == 1 and props["name"]["type"] == "text"
    assert props["status"]["type"] == "select" and {o["v"] for o in props["status"]["options"]} == {
        "want",
        "been",
    }
    assert props["went"]["type"] == "date"
    assert props["url"]["type"] == "url" and props["url"]["pattern"].startswith("^https://")
    assert props["who"] == {
        "tbl": "places",
        "col": "who",
        "type": "ref",
        "ref_table": "people",
        "required": 1,
    }
    assert props["tags"]["type"] == "multi_select" and {
        o["v"] for o in props["tags"]["options"]
    } == {"bar", "cafe"}


def test_infer_skips_cataloged_columns_and_small_tables(db):
    create_table(db, "places", ["name:text"])
    insert_rows(db, "places", [{"name": "a"}])
    assert infer(db, "places") == []


# --- doc ------------------------------------------------------------------


def test_doc_renders_tables_properties_and_rules(db):
    set_table(db, "places", kind="table", purpose="somewhere real", id_semantics="Google place_id")
    set_property(
        db,
        "places",
        "status",
        type="select",
        required=1,
        sort=1,
        options=[{"v": "want", "d": "saved"}, {"v": "been"}],
        description="lowercase",
    )
    set_property(db, "places", "slug", type="text", sort=2, derived_by="http:slug", inputs=["name"])
    set_rule(db, "estate-soft-delete", scope="estate", kind="doctrine", text="soft delete only")
    with connect(db) as conn:
        md = doc(conn)
    assert "### places" in md and "somewhere real" in md and "Google place_id" in md
    assert "| status | select | yes | `want` (saved), `been` | lowercase |" in md
    assert "derived by `http:slug` from name" in md
    assert "## Estate rules" in md and "soft delete only" in md
    with connect(db) as conn:
        assert doc(conn) == md  # deterministic


def test_doc_scoped_to_one_table_omits_estate_rules(db):
    set_table(db, "places", kind="table", purpose="somewhere real")
    set_table(db, "movies", kind="table", purpose="watched films")
    set_rule(db, "estate-soft-delete", scope="estate", kind="doctrine", text="soft delete only")
    with connect(db) as conn:
        md = doc(conn, "places")
    assert "### places" in md and "### movies" not in md
    assert "## Estate rules" not in md


def test_doc_escapes_pipe_in_cells(db):
    set_property(db, "places", "status", type="text", description="a | b")
    with connect(db) as conn:
        md = doc(conn)
    rows = [line for line in md.splitlines() if line.startswith("| status")]
    assert rows == ["| status | text |  |  | a \\| b |"]
    cells = re.split(r"(?<!\\)\|", rows[0])[1:-1]  # drop the leading/trailing empty splits
    assert len(cells) == 5


def test_infer_ref_prefers_tightest_fitting_table(db):
    # created first, so sqlite_master order alone would pick it over people
    create_table(db, "everything", ["name:text"])
    insert_rows(db, "everything", [{"id": f"p{i}", "name": f"n{i}"} for i in range(50)])
    create_table(db, "people", ["name:text"])
    insert_rows(db, "people", [{"id": f"p{i}", "name": f"n{i}"} for i in range(25)])
    create_table(db, "places", ["who:text"])
    insert_rows(db, "places", [{"who": f"p{i}"} for i in range(25)])
    props = {p["col"]: p for p in infer(db, "places")}
    assert props["who"]["ref_table"] == "people"


# --- write-path escapes and temp-table safety --------------------------------


def test_cte_write_is_validated(db):
    create_table(db, "places", ["name:text", "status:select(want|been)"])
    with pytest.raises(ValidationError):
        execute_sql(
            db,
            "WITH v(n,s) AS (VALUES('x','TOTALLY_BAD')) "
            "INSERT INTO places (name,status) SELECT n,s FROM v",
        )
    assert execute_sql(db, "SELECT count(*) AS c FROM places")[0]["c"] == 0


def test_cte_read_still_works(db):
    create_table(db, "places", ["name:text"])
    insert_rows(db, "places", [{"id": "p1", "name": "x"}])
    rows = execute_sql(db, "WITH v AS (SELECT name FROM places) SELECT * FROM v")
    assert [r["name"] for r in rows] == ["x"]


def test_temp_context_never_drops_a_user_table_named_changed(db):
    create_table(db, "changed", ["name:text"])
    create_table(db, "notes", ["body:text"])
    insert_rows(db, "changed", [{"id": "c1", "name": "keep"}])
    set_rule(
        db,
        "r",
        scope="table",
        tbl="notes",
        kind="invariant",
        enforce=1,
        text="x",
        sql="SELECT id FROM changed WHERE 0",
    )
    insert_rows(db, "notes", [{"id": "n1", "body": "b"}])
    assert [r["name"] for r in execute_sql(db, "SELECT name FROM changed")] == ["keep"]


def test_inputs_hash_renders_reals_the_way_sqlite_stored_them(db):
    import hashlib

    create_table(db, "orders", ["qty:number"])
    insert_rows(db, "orders", [{"id": "o1", "qty": 4}])
    with connect(db) as conn:
        assert inputs_hash(conn, "orders", "o1", ["qty"]) == hashlib.sha256(b'["4.0"]').hexdigest()
        assert value_hash(conn, "orders", "o1", "qty") == hashlib.sha256(b"4.0").hexdigest()


def test_int_cells_hash_as_integers_and_earlier_real_proofs_stay_fresh(db):
    """A replica renders a stored INTEGER 1999 as "1999", like the hub's typed
    rendering. Hubs used to hash a rebound D1 number as "1999.0"; those proofs
    must stay fresh and keep admitting their values, not force a re-derive."""
    import hashlib

    def sha(text):
        return hashlib.sha256(text.encode()).hexdigest()

    create_table(db, "albums", ["year:int", "decade:int"])
    set_property(db, "albums", "decade", type="int", derived_by="http:decade", inputs=["year"])
    insert_rows(db, "albums", [{"id": "a", "year": 1999}])
    with connect(db) as conn:
        conn.execute("UPDATE albums SET decade = 1990 WHERE id = 'a'")
        assert inputs_hash(conn, "albums", "a", ["year"]) == sha('["1999"]')
        assert value_hash(conn, "albums", "a", "decade") == sha("1990")
        conn.execute(
            "INSERT INTO provenance (id, to_kind, to_ref, field, from_kind, from_ref, rel, asserted_by, inputs_hash, value_hash) "
            "VALUES ('albums:a:decade','albums','a','decade','http:decade','x','derived_from','hub',?,?)",
            (sha('["1999.0"]'), sha("1990.0")),
        )
        conn.commit()
    assert [f for f in check(db) if f["col"] == "decade"] == []
    with connect(db) as conn:
        conn.execute("UPDATE albums SET decade = NULL WHERE id = 'a'")
        conn.commit()
        _, rejected = validate_push(conn, "albums", [{"id": "a", "year": 1999, "decade": 1990}])
    assert rejected == []
    execute_sql(db, "UPDATE albums SET year = 2001 WHERE id = 'a'")
    assert ("decade", "stale") in {(f["col"], f["rule"]) for f in check(db)}


def test_check_reports_orphan_provenance_after_a_hard_delete(db):
    import sqlite3 as s

    _movies(db)
    insert_rows(db, "movies", [{"id": "m1", "title": "x", "tmdb_id": "78"}])
    _record_provenance(db, "movies", "m1", "slug", ["title"])
    conn = s.connect(db)
    conn.execute("DELETE FROM movies WHERE id = 'm1'")
    conn.commit()
    conn.close()
    findings = check(db)
    assert ("m1", "orphan") in {(f["row_id"], f["rule"]) for f in findings}


def test_set_rule_requires_sql_for_an_invariant(db):
    create_table(db, "places", ["status:text"])
    with pytest.raises(ValueError, match="sql"):
        set_rule(db, "r", scope="table", tbl="places", kind="invariant", enforce=1, text="x")


def test_check_reports_rule_error_instead_of_crashing(db):
    import sqlite3 as s

    create_table(db, "places", ["status:text"])
    set_rule(
        db,
        "r",
        scope="table",
        tbl="places",
        kind="invariant",
        enforce=0,
        text="x",
        sql="SELECT id FROM places WHERE status = 'z'",
    )
    conn = s.connect(db)
    conn.execute("DROP TABLE places")
    conn.commit()
    conn.close()
    errs = [f for f in check(db) if f["rule"] == "rule-error"]
    assert errs and errs[0]["message"].startswith("r failed to run:")


def test_enforced_invariant_runs_for_a_table_with_no_properties(db):
    execute_sql(
        db,
        "CREATE TABLE widgets (id TEXT PRIMARY KEY, kind TEXT, "
        "created_at TEXT, updated_at TEXT, deleted_at TEXT)",
    )
    set_rule(
        db,
        "no-bad",
        scope="table",
        tbl="widgets",
        kind="invariant",
        enforce=1,
        text="kind must not be bad",
        sql="SELECT id FROM widgets WHERE kind = 'bad'",
    )
    with pytest.raises(ValidationError, match="kind must not be bad"):
        execute_sql(
            db,
            "INSERT INTO widgets (id, kind, updated_at) "
            "VALUES ('w1','bad','2026-01-01T00:00:00.000Z')",
        )
    assert execute_sql(db, "SELECT count(*) AS c FROM widgets")[0]["c"] == 0


def test_set_rule_rejects_an_enforced_estate_invariant(db):
    create_table(db, "places", ["status:text"])
    with pytest.raises(ValueError, match="estate"):
        set_rule(
            db,
            "r",
            scope="estate",
            kind="invariant",
            enforce=1,
            text="x",
            sql="SELECT id FROM places WHERE 0",
        )


def test_unenforced_rule_on_a_legacy_table_does_not_break_other_writes(db):
    create_table(db, "places", ["name:text"])
    execute_sql(db, "CREATE TABLE legacy (k TEXT)")  # no id/updated_at
    set_rule(
        db,
        "legacy-r",
        scope="table",
        tbl="legacy",
        kind="invariant",
        enforce=0,
        text="x",
        sql="SELECT k FROM legacy WHERE k = 'bad'",
    )
    insert_rows(db, "places", [{"id": "p1", "name": "ok"}])
    assert execute_sql(db, "SELECT count(*) AS c FROM places")[0]["c"] == 1


def test_set_rule_rejects_enforcing_a_table_without_sync_columns(db):
    execute_sql(db, "CREATE TABLE legacy (k TEXT)")
    with pytest.raises(ValueError, match="sync columns"):
        set_rule(
            db,
            "legacy-r",
            scope="table",
            tbl="legacy",
            kind="invariant",
            enforce=1,
            text="x",
            sql="SELECT k FROM legacy WHERE k = 'bad'",
        )


# --- provenance is one table for every value's origin ---------------------------


def _edge(**o):
    return {
        "id": "imessage:GUID-1:m1",
        "from_kind": "imessage",
        "from_ref": "GUID-1",
        "to_kind": "movies",
        "to_ref": "m1",
        "rel": "evidence_of",
        "field": "date_watched",
        "detail": {"cue": "just watched it", "confidence": "high"},
        "asserted_by": "agent:s1",
        **o,
    }


def test_provenance_is_cataloged_from_birth(db):
    """provenance is engine-created but a USER table for validation: every
    column has a catalog property, so a client-written edge is checked."""
    ensure_catalog(db)
    with connect(db) as conn:
        cols = {p["col"]: p for p in properties(conn, "provenance")}
    assert {
        "from_kind",
        "from_ref",
        "to_kind",
        "to_ref",
        "rel",
        "field",
        "detail",
        "asserted_by",
    } <= set(cols)
    assert all(cols[c].get("description") for c in cols), "every provenance column is described"
    assert cols["rel"]["required"] == 1 and cols["asserted_by"]["required"] == 1


def test_client_edge_is_validated(db):
    create_table(db, "movies", ["title:text"])
    insert_rows(db, "movies", [{"id": "m1", "title": "x"}])
    insert_rows(db, "provenance", [_edge()])
    with pytest.raises(ValidationError, match="rel"):
        insert_rows(
            db, "provenance", [_edge(id="imessage:GUID-2:m1", from_ref="GUID-2", rel="vibes")]
        )
    with pytest.raises(ValidationError, match="asserted_by"):
        insert_rows(
            db, "provenance", [_edge(id="imessage:GUID-3:m1", from_ref="GUID-3", asserted_by=None)]
        )
    with pytest.raises(ValidationError, match="to_kind"):
        insert_rows(
            db,
            "provenance",
            [_edge(id="imessage:GUID-4:m1", from_ref="GUID-4", to_kind="not_a_table")],
        )


def test_every_derivation_is_an_allowed_from_kind(db):
    """A hub derivation's `http:<name>` is a from_kind the moment the catalog
    declares a column derived by it - no option list to maintain."""
    create_table(db, "movies", ["title:text"])
    insert_rows(db, "movies", [{"id": "m1"}])
    bad = _edge(
        id="http:tmdb:m1",
        from_kind="http:tmdb",
        from_ref="h",
        rel="derived_from",
        asserted_by="hub",
    )
    with pytest.raises(ValidationError, match="from_kind"):
        insert_rows(db, "provenance", [bad])
    set_property(db, "movies", "title", type="text", derived_by="http:tmdb", inputs=["id"])
    insert_rows(db, "provenance", [bad])


def test_set_property_defaults_type_to_text_on_create(db):
    set_property(db, "places", "id", immutable=1)
    set_property(db, "places", "id", description="Google place_id")  # an update never resets type
    with connect(db) as conn:
        assert properties(conn, "places")[0]["type"] == "text"
        assert "| id | text |  | immutable | Google place_id |" in doc(conn)


def test_cli_table_set_consumers_accepts_json_or_comma_list(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("SOMA_DATA_DIR", str(tmp_path))
    from soma import main

    main(["init"])
    capsys.readouterr()  # drop init's path line
    main(["table", "set", "pets", "--consumers", '["a", "b"]'])
    assert json.loads(capsys.readouterr().out)["consumers"] == ["a", "b"]
    main(["table", "set", "pets", "--consumers", "a, b"])
    assert json.loads(capsys.readouterr().out)["consumers"] == ["a", "b"]


# --- history ----------------------------------------------------------------


def _hist(db, **where):
    cond = " AND ".join(f"{k} = ?" for k in where) or "1=1"
    return (
        execute_sql(db, f"SELECT * FROM history WHERE {cond} ORDER BY created_at, rowid")
        if not where
        else [
            r
            for r in execute_sql(db, "SELECT * FROM history ORDER BY created_at, rowid")
            if all(r[k] == v for k, v in where.items())
        ]
    )


def test_update_writes_one_history_row_per_changed_cell(db):
    create_table(db, "places", ["name:text", "status:select(want|been)", "rating:int"])
    insert_rows(db, "places", [{"id": "p1", "name": "Bar", "status": "want"}])
    assert _hist(db) == [], "an insert is not history: created_at plus the row already say it"
    execute_sql(db, "UPDATE places SET status = 'been', rating = 4 WHERE id = 'p1'")
    rows = _hist(db, tbl="places", row_id="p1")
    assert {(r["col"], r["old"], r["new"]) for r in rows} == {
        ("status", "want", "been"),
        ("rating", None, "4"),
    }
    assert all(r["origin"] for r in rows), "every row says which machine wrote it"
    assert all(r["created_at"] for r in rows)
    assert not [r for r in rows if r["col"] in ("updated_at", "hub_at")]


def test_soft_delete_and_untouched_cells_in_history(db):
    create_table(db, "places", ["name:text"])
    insert_rows(db, "places", [{"id": "p1", "name": "Bar"}])
    execute_sql(db, "UPDATE places SET name = 'Bar' WHERE id = 'p1'")  # no-op change
    assert _hist(db) == []
    execute_sql(db, "UPDATE places SET deleted_at = updated_at WHERE id = 'p1'")
    rows = _hist(db, tbl="places", row_id="p1")
    assert [r["col"] for r in rows] == ["deleted_at"]
    assert rows[0]["old"] is None and rows[0]["new"]


def test_rejected_write_leaves_no_history(db):
    create_table(db, "places", ["status:select(want|been)"])
    insert_rows(db, "places", [{"id": "p1", "status": "want"}])
    with pytest.raises(ValidationError):
        execute_sql(db, "UPDATE places SET status = 'nope' WHERE id = 'p1'")
    assert _hist(db) == []


def test_history_is_an_engine_table_created_with_the_catalog_and_documented(db):
    ensure_catalog(db)
    ddls = [r["ddl"] for r in execute_sql(db, "SELECT ddl FROM _schema_log")]
    assert any('CREATE TABLE "history"' in d for d in ddls), "logged DDL, so it syncs"
    with connect(db) as conn:
        cols = {p["col"]: p for p in properties(conn, "history")}
        assert {"tbl", "row_id", "col", "old", "new", "origin"} <= set(cols)
        assert all(cols[c].get("description") for c in cols)
        assert "### history" in doc(conn)
    # engine table: never validated, never snapshotted, never its own history
    execute_sql(db, "UPDATE history SET origin = 'x' WHERE 0")
    create_table(db, "places", ["name:text"])
    insert_rows(db, "places", [{"id": "p1", "name": "a"}])
    execute_sql(db, "UPDATE places SET name = 'b' WHERE id = 'p1'")
    assert [r["tbl"] for r in _hist(db)] == ["places"]


def test_history_table_appears_lazily_on_an_estate_that_predates_it(db):
    create_table(db, "places", ["name:text"])
    execute_sql(db, "DROP TABLE history")  # an estate cataloged before history existed
    insert_rows(db, "places", [{"id": "p1", "name": "a"}])
    execute_sql(db, "UPDATE places SET name = 'b' WHERE id = 'p1'")
    assert [(r["old"], r["new"]) for r in _hist(db)] == [("a", "b")]
    ddls = [r["ddl"] for r in execute_sql(db, "SELECT ddl FROM _schema_log")]
    assert len([d for d in ddls if 'CREATE TABLE "history"' in d]) == 2, "re-created via logged DDL"


def test_markdown_type_stores_text_and_keeps_numeric_looking_bodies_as_text(db):
    create_table(db, "notes", ["title:text!", "body:markdown"])
    cols = {r["name"]: r["type"] for r in execute_sql(db, "PRAGMA table_info(notes)")}
    assert cols["body"] == "TEXT"
    insert_rows(db, "notes", [{"id": "n1", "title": "t", "body": "123"}])
    row = execute_sql(db, "SELECT typeof(body) AS t FROM notes WHERE id = 'n1'")[0]
    assert row["t"] == "text"
    (prop,) = [p for p in properties(connect(db), "notes") if p["col"] == "body"]
    assert prop["type"] == "markdown"


def test_markdown_property_type_is_accepted_by_property_set(db):
    create_table(db, "notes", ["title:text!", "body:text"])
    set_property(db, "notes", "body", type="markdown")
    (prop,) = [p for p in properties(connect(db), "notes") if p["col"] == "body"]
    assert prop["type"] == "markdown"


def test_set_table_display_names_the_column_that_titles_a_row(db):
    create_table(db, "places", ["name:text!", "city:text"])
    set_table(db, "places", display="name")
    t = execute_sql(db, "SELECT display FROM catalog_tables WHERE id='places'")[0]
    assert t["display"] == "name"
    with connect(db) as conn:
        assert "- **Row title:** `name`" in doc(conn, "places")


def test_set_table_display_rejects_a_column_the_table_does_not_have(db):
    create_table(db, "places", ["name:text!"])
    with pytest.raises(ValueError, match="no column"):
        set_table(db, "places", display="title")


def test_an_estate_without_the_display_column_gains_it_through_logged_ddl(db):
    create_table(db, "places", ["name:text!"])
    ensure_catalog(db)
    with connect(db) as conn:
        conn.execute("ALTER TABLE catalog_tables DROP COLUMN display")
        conn.execute("DELETE FROM _schema_log WHERE ddl LIKE '%display%'")
    set_table(db, "places", display="name")
    cols = [r["name"] for r in execute_sql(db, "PRAGMA table_info(catalog_tables)")]
    assert "display" in cols
    ddls = [r["ddl"] for r in execute_sql(db, "SELECT ddl FROM _schema_log")]
    assert any("ADD COLUMN" in d and "display" in d for d in ddls)


def test_mixed_calendar_property_stores_both_precisions(db):
    create_table(db, "items", ["due:date_or_datetime"])
    insert_rows(
        db,
        "items",
        [
            {"id": "all-day", "due": "2032-02-29"},
            {"id": "timed", "due": "2032-02-29T05:00:00.000Z"},
        ],
    )
    with connect(db) as conn:
        assert properties(conn, "items")[0]["type"] == "date_or_datetime"
    assert execute_sql(db, "SELECT due FROM items ORDER BY id") == [
        {"due": "2032-02-29"},
        {"due": "2032-02-29T05:00:00.000Z"},
    ]
    assert (
        next(r for r in execute_sql(db, "PRAGMA table_info(items)") if r["name"] == "due")["type"]
        == "TEXT"
    )


def test_option_colors_use_the_notion_palette(db):
    create_table(db, "places", ["name:text", "status:text"])
    prop = set_property(
        db,
        "places",
        "status",
        type="select",
        options=[{"v": "want", "color": " Blue "}, {"v": "been", "color": None}, {"v": "live"}],
    )
    assert prop["options"] == [{"v": "want", "color": "blue"}, {"v": "been"}, {"v": "live"}]
    with pytest.raises(ValueError, match="color"):
        set_property(db, "places", "status", options=[{"v": "want", "color": "teal"}])
