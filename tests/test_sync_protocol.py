"""The same revision cases run against Python and the TypeScript UI core."""

import json
import subprocess
from pathlib import Path

import pytest

from soma import HttpHub, LocalHub, connect, create_table, execute_sql, init, sync

CASES = json.loads((Path(__file__).parent / "fixtures/sync-protocol/revisions.json").read_text())
DDL = "CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT, updated_at TEXT, deleted_at TEXT, hub_at TEXT)"


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["name"])
def test_shared_revision_protocol(tmp_path, case):
    path = init(tmp_path / "replica.db")
    hub = LocalHub(tmp_path / "hub.db")
    hub.ensure_ready()
    for target, row in [(path, case["local"]), (hub.path, case["remote"])]:
        execute_sql(target, DDL)
        with connect(target) as conn:
            conn.execute(
                "INSERT INTO items(id,name,updated_at,deleted_at,hub_at) VALUES (?,?,?,?,?)",
                (*row.values(), "2026-01-04T00:00:00.000Z"),
            )
    assert sync(path, hub)["rejected"] == []
    for target in [path, hub.path]:
        assert execute_sql(target, "SELECT id,name,updated_at,deleted_at FROM items") == [
            case["expected"]
        ]
    assert sync(path, hub)["rejected"] == []
    assert execute_sql(path, "SELECT id,name,updated_at,deleted_at FROM items") == [
        case["expected"]
    ]


@pytest.mark.parametrize("partial", [False, True])
def test_python_respects_core_endpoint_binding(tmp_path, monkeypatch, partial):
    path = tmp_path / "replica.db"
    subprocess.run(
        ["bun", "-", str(path), str(partial)],
        input="""
import { Database } from 'bun:sqlite';
import { setup } from './core/test/support.ts';
import { sync } from './core/src/sync.ts';
const {db,hub}=setup();
db.db.close(); db.db=new Database(process.argv[2]);
const partial=process.argv[3]==='True';
const transport={...hub,async post(route,body){
  if(partial&&route==='/v1/stats') throw new Error('offline');
  return hub.post(route,body);
}};
try { await sync(db,transport); }
catch(error) { if(!partial||error.message!=='offline') throw error; }
db.db.close();
""",
        text=True,
        check=True,
        cwd=Path(__file__).resolve().parents[1],
    )
    init(path)
    hub = HttpHub("https://other.test")
    monkeypatch.setattr(hub, "ensure_ready", lambda: pytest.fail("contacted another hub"))
    with pytest.raises(ValueError, match="hub changed"):
        sync(path, hub)


def test_python_sync_does_not_acknowledge_ui_pending_markers(tmp_path):
    path = init(tmp_path / "replica.db")
    create_table(path, "items", ["name:text!"])
    hub = LocalHub(tmp_path / "hub.db")
    assert sync(path, hub)["rejected"] == []

    def ui_status(action):
        result = subprocess.run(
            ["bun", "-", str(path), action],
            input="""
import { Database } from 'bun:sqlite';
import { TestSql } from './core/test/support.ts';
import { writeRow, syncStatus } from './core/src/index.ts';
const db=new TestSql(); db.db.close(); db.db=new Database(process.argv[2]);
if(process.argv[3]==='write') await writeRow(db,'items',{name:'UI edit'},{id:()=> 'ui'});
console.log(JSON.stringify(await syncStatus(db))); db.db.close();
""",
            text=True,
            capture_output=True,
            check=True,
            cwd=Path(__file__).resolve().parents[1],
        )
        return json.loads(result.stdout)

    pending = {
        "lastSuccessfulSync": None,
        "pendingUiEdits": 1,
        "rejected": 0,
        "skippedTables": [],
        "skippedDetails": [],
    }
    assert ui_status("write") == pending
    execute_sql(path, "INSERT INTO items(id,name) VALUES ('cli','CLI edit')")
    assert sync(path, hub)["rejected"] == []
    assert execute_sql(hub.path, "SELECT id FROM items ORDER BY id") == [
        {"id": "cli"},
        {"id": "ui"},
    ]
    assert ui_status("read") == pending
    assert execute_sql(hub.path, "SELECT name FROM sqlite_master WHERE name='_core_pending'") == []
