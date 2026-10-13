"""`soma property rename`: a column and every reference to it, in one transaction."""

import json

import pytest
from test_saved_views import client

from soma import (
    LocalHub,
    catalog,
    create_table,
    execute_sql,
    init,
    insert_rows,
    main,
    rename_column,
    sync,
)


@pytest.fixture()
def db(tmp_path):
    path = init(tmp_path / "soma.db")
    catalog.ensure_catalog(path)
    create_table(path, "people", ["name:text!", "slug:text", "status:select(new|met)"])
    catalog.set_property(path, "people", "name", label="Name", description="Display name.")
    catalog.set_property(
        path, "people", "slug", type="text", derived_by="http:slug", inputs=["name", "status"]
    )
    catalog.set_table(path, "people", kind="table", display="name")
    catalog.set_rule(
        path,
        "people-named",
        scope="table",
        tbl="people",
        col="name",
        kind="invariant",
        text="a person has a name",
        sql="SELECT id FROM people WHERE name = '' AND id IN (SELECT id FROM changed)",
        enforce=1,
    )
    # Another table with a same-named column: never touched by a people rename.
    create_table(path, "pets", ["name:text", "owner:ref"])
    catalog.set_property(path, "pets", "owner", type="ref", ref_table="people")
    catalog.set_table(path, "pets", kind="table", display="name")
    insert_rows(path, "people", [{"id": "a1", "name": "Ada", "status": "new"}])
    insert_rows(path, "pets", [{"id": "p1", "name": "Rex", "owner": "a1"}])
    execute_sql(path, "UPDATE people SET name = 'Ada L' WHERE id = 'a1'")
    execute_sql(path, "UPDATE pets SET name = 'Rex II' WHERE id = 'p1'")
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
                "rel": "evidence_of",
                "field": "name",
                "asserted_by": "test",
            },
        ],
    )
    create_table(path, "views", ["name:text!", "tbl:ref!", "definition:json!"])
    catalog.set_property(path, "views", "tbl", ref_table="catalog_tables")
    catalog.set_table(path, "views", kind="table", display="name")
    catalog.set_property(
        path, "views", "definition", source="life-core", source_ref="saved-views/v1"
    )
    return path


EVERY_PLACE = {
    "version": 2,
    "columns": ["name", "status"],
    "filters": [{"column": "name", "op": "contains", "value": "A"}],
    "groups": [{"match": "any", "filters": [{"column": "name", "op": "empty"}]}],
    "sort": [{"column": "name", "direction": "asc"}],
    "widths": {"status": 120, "name": 200},
    "wrap": ["name"],
    "actions": [{"id": "retitle", "label": "Retitle", "values": {"name": "X"}}],
    "layout": [{"kind": "column", "id": "name"}, {"kind": "action", "id": "retitle"}],
}


def _live(path, table, **where):
    cond = " AND ".join(f"{k} = '{v}'" for k, v in where.items())
    return execute_sql(path, f"SELECT * FROM {table} WHERE deleted_at IS NULL AND {cond}")


def test_rename_column_moves_every_reference_in_one_transaction(db):
    insert_rows(
        db,
        "views",
        [
            {"id": "v", "name": "All", "tbl": "people", "definition": json.dumps(EVERY_PLACE)},
            {"id": "w", "name": "Pets", "tbl": "pets", "definition": '{"columns":["name"]}'},
        ],
    )
    # a synced revision ahead of this device's clock must still be superseded
    before = "2099-01-01T00:00:00.000Z"
    execute_sql(db, f"UPDATE views SET updated_at = '{before}' WHERE id = 'v'")
    rename_column(db, "people", "name", "full_name")

    cols = [r["name"] for r in execute_sql(db, "PRAGMA table_info(people)")]
    assert "full_name" in cols and "name" not in cols
    assert execute_sql(db, "SELECT full_name FROM people") == [{"full_name": "Ada L"}]
    # catalog: the property is rekeyed with its definition, the old id tombstoned
    prop = _live(db, "catalog_properties", id="people.full_name")[0]
    assert (prop["col"], prop["label"], prop["required"]) == ("full_name", "Name", 1)
    assert prop["description"] == "Display name."
    assert _live(db, "catalog_properties", id="people.name") == []
    assert json.loads(_live(db, "catalog_properties", id="people.slug")[0]["inputs"]) == [
        "full_name",
        "status",
    ]
    assert _live(db, "catalog_tables", id="people")[0]["display"] == "full_name"
    rule = _live(db, "catalog_rules", id="people-named")[0]
    assert rule["col"] == "full_name" and "WHERE full_name = ''" in rule["sql"]
    # provenance: the field follows; the other table is untouched
    assert _live(db, "provenance", id="imessage:G1:a1")[0]["field"] == "full_name"
    assert _live(db, "catalog_properties", id="pets.name")[0]["col"] == "name"
    assert _live(db, "catalog_tables", id="pets")[0]["display"] == "name"
    # history follows the column, and only that table's column
    assert execute_sql(
        db, "SELECT tbl, col FROM history WHERE tbl IN ('people','pets') ORDER BY tbl"
    ) == [
        {"tbl": "people", "col": "full_name"},
        {"tbl": "pets", "col": "name"},
    ]
    # saved views of that table name the new column everywhere; revision moves forward
    view = execute_sql(db, "SELECT definition, updated_at FROM views WHERE id = 'v'")[0]
    assert view["updated_at"] > before
    assert "name" not in json.dumps(json.loads(view["definition"])).replace("full_name", "")
    assert json.loads(view["definition"])["widths"] == {"status": 120, "full_name": 200}
    assert execute_sql(db, "SELECT definition FROM views WHERE id = 'w'") == [
        {"definition": '{"columns":["name"]}'}
    ]
    listed = {v["id"]: v for v in client(db, "listViews", {"table": "people"})["views"]}
    assert listed["v"]["unavailable"] is None
    # the renamed column is enforced and logged like any other
    with pytest.raises(catalog.ValidationError) as exc:
        execute_sql(db, "UPDATE people SET full_name = '' WHERE id = 'a1'")
    assert "people-named" in {v.rule for v in exc.value.violations}
    execute_sql(db, "UPDATE people SET full_name = 'Ada' WHERE id = 'a1'")
    assert [
        r["old"]
        for r in execute_sql(db, "SELECT old FROM history WHERE tbl='people' ORDER BY created_at")
    ] == ["Ada", "Ada L"]
    ddls = [r["ddl"] for r in execute_sql(db, "SELECT ddl FROM _schema_log")]
    assert 'ALTER TABLE "people" RENAME COLUMN "name" TO "full_name"' in ddls


def test_rename_column_rekeys_derivation_proofs(db):
    rename_column(db, "people", "slug", "handle")
    assert _live(db, "provenance", id="people:a1:slug") == []
    proof = _live(db, "provenance", id="people:a1:handle")[0]
    assert (proof["field"], proof["from_kind"]) == ("handle", "http:slug")
    assert _live(db, "catalog_properties", id="people.handle")[0]["derived_by"] == "http:slug"


def test_rename_column_refuses_bad_targets(db):
    with pytest.raises(ValueError, match="no such column"):
        rename_column(db, "people", "nope", "x")
    with pytest.raises(ValueError, match="no such table"):
        rename_column(db, "nope", "name", "x")
    with pytest.raises(ValueError, match="already exists"):
        rename_column(db, "people", "name", "status")
    with pytest.raises(ValueError, match="engine"):
        rename_column(db, "history", "col", "column")
    for reserved in ("id", "updated_at", "deleted_at", "hub_at", "created_at"):
        with pytest.raises(ValueError, match="sync column"):
            rename_column(db, "people", reserved, "x")
        with pytest.raises(ValueError, match="sync column"):
            rename_column(db, "people", "name", reserved)
    with pytest.raises(ValueError):
        rename_column(db, "people", "name", "bad name")
    assert execute_sql(db, "SELECT name FROM people") == [{"name": "Ada L"}]


def test_rename_column_rolls_back_when_another_table_rule_still_names_it(db):
    catalog.set_rule(
        db,
        "pets-owned",
        scope="table",
        tbl="pets",
        kind="invariant",
        text="an owner has a name",
        sql="SELECT p.id FROM pets p JOIN people o ON o.id = p.owner WHERE o.name = ''",
    )
    with pytest.raises(catalog.ValidationError):
        rename_column(db, "people", "name", "full_name")
    assert execute_sql(db, "SELECT name FROM people") == [{"name": "Ada L"}]
    assert _live(db, "catalog_properties", id="people.name")


def test_sql_rename_column_is_refused(db):
    with pytest.raises(ValueError, match="soma property rename"):
        execute_sql(db, "ALTER TABLE people RENAME COLUMN name TO full_name")
    with pytest.raises(ValueError, match="soma property rename"):
        execute_sql(db, 'alter table "people" rename "name" to "full_name"')


def test_rename_column_replays_to_the_hub_and_every_replica(db, tmp_path):
    hub = LocalHub(tmp_path / "hub.db")
    sync(db, hub)
    other = init(tmp_path / "other" / "soma.db")
    sync(other, hub)
    rename_column(db, "people", "name", "full_name")
    sync(db, hub)
    sync(other, hub)
    assert execute_sql(other, "SELECT full_name FROM people") == [{"full_name": "Ada L"}]
    assert _live(other, "catalog_properties", id="people.name") == []
    assert _live(other, "catalog_properties", id="people.full_name")[0]["required"] == 1
    assert {r["col"] for r in execute_sql(other, "SELECT col FROM history WHERE tbl='people'")} == {
        "full_name"
    }
    fresh = init(tmp_path / "fresh" / "soma.db")
    sync(fresh, hub)
    assert execute_sql(fresh, "SELECT full_name FROM people") == [{"full_name": "Ada L"}]
    execute_sql(other, "UPDATE people SET full_name = 'Ada' WHERE id = 'a1'")
    sync(other, hub)
    sync(db, hub)
    assert execute_sql(db, "SELECT full_name FROM people")[0]["full_name"] == "Ada"


def test_cli_property_rename(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("SOMA_DATA_DIR", str(tmp_path))
    assert main(["init"]) == 0
    assert main(["table", "create", "pets", "name:text"]) == 0
    assert main(["property", "rename", "pets.name", "label"]) == 0
    assert "renamed pets.name -> pets.label" in capsys.readouterr().out
    assert main(["sql", "ALTER TABLE pets RENAME COLUMN label TO x"]) == 1
    assert "soma property rename" in capsys.readouterr().err
    assert main(["sql", "SELECT label FROM pets"]) == 0
