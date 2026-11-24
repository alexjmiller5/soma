"""Hub boundary regressions using only isolated, synthetic stores."""

from itertools import pairwise

import pytest

from soma import LocalHub, catalog, connect, create_table, execute_sql, init, sync

T0 = "2025-01-01T00:00:00.000Z"
T1 = "2025-01-02T00:00:00.000Z"
T2 = "2025-01-03T00:00:00.000Z"


@pytest.fixture
def hub(tmp_path):
    h = LocalHub(init(tmp_path / "hub.db"))
    create_table(h.path, "items", ["name:text!", "qty:int"])
    return h


def push(hub, rows, table="items"):
    return hub.rows_push(table, list(dict.fromkeys(k for r in rows for k in r)), rows)


@pytest.mark.parametrize(
    "stamp",
    [
        "",
        "tomorrow",
        "2025-02-29T00:00:00.000Z",
        "2025-01-01T24:00:00.000Z",
        "2025-01-01T23:60:00.000Z",
        "2025-01-01T23:59:60.000Z",
        "2025-01-01T00:00:00Z",
        "2025-01-01T00:00:00.000+00:00",
        123,
        None,
    ],
)
def test_protocol_timestamp_without_catalog(hub, stamp):
    with connect(hub.path) as c:
        c.execute("CREATE TABLE raw (id TEXT PRIMARY KEY, updated_at TEXT)")
    out = push(hub, [{"id": "a", "updated_at": stamp}], "raw")
    assert out["upserted"] == 0
    assert out["rejected"][0]["col"] == "updated_at"
    assert execute_sql(hub.path, "SELECT * FROM raw") == []


def test_duplicate_ids_validate_evolving_state(hub):
    out = push(
        hub, [{"id": "a", "name": "A", "updated_at": T0}, {"id": "a", "qty": 2, "updated_at": T1}]
    )
    assert out["rejected"] == []
    assert execute_sql(hub.path, "SELECT name, qty FROM items") == [{"name": "A", "qty": 2}]


def test_invariant_rollback_history_and_mixed_rows(hub):
    push(hub, [{"id": "a", "name": "A", "qty": 2, "updated_at": T0}])
    catalog.set_rule(
        hub.path,
        "nondecreasing",
        kind="invariant",
        tbl="items",
        enforce=1,
        text="quantity cannot decrease",
        sql="SELECT c.id FROM changed c JOIN before b USING(id) WHERE c.qty < b.qty",
    )
    out = push(
        hub,
        [
            {"id": "a", "qty": 1, "updated_at": T1},
            {"id": "b", "name": "B", "qty": 3, "updated_at": T1},
        ],
    )
    assert out["upserted"] == 1
    assert out["rejected"][0]["rule"] == "nondecreasing"
    assert execute_sql(hub.path, "SELECT qty FROM items WHERE id='a'")[0]["qty"] == 2
    assert execute_sql(hub.path, "SELECT * FROM history") == []
    assert not push(hub, [{"id": "a", "qty": 4, "updated_at": T2}])["rejected"]
    assert execute_sql(hub.path, "SELECT col, old, new FROM history") == [
        {"col": "qty", "old": "2", "new": "4"}
    ]
    push(hub, [{"id": "a", "qty": 1, "updated_at": T0}])
    push(hub, [{"id": "a", "qty": 4, "updated_at": T2}])
    assert len(execute_sql(hub.path, "SELECT * FROM history")) == 1


@pytest.mark.parametrize("table", ["changed", "before", "now"])
def test_context_names_preserve_user_tables(hub, table):
    create_table(hub.path, table, ["name:text"])
    catalog.set_rule(
        hub.path,
        "context",
        kind="invariant",
        tbl=table,
        enforce=1,
        text="bad name",
        sql="SELECT id FROM changed WHERE name = 'bad' AND (SELECT ts FROM now) IS NOT NULL",
    )
    out = push(hub, [{"id": "a", "name": "bad", "updated_at": T0}], table)
    assert out["rejected"][0]["rule"] == "context"
    assert execute_sql(hub.path, f'SELECT * FROM "{table}"') == []


def test_replica_history_does_not_double_log(hub, tmp_path):
    replica = init(tmp_path / "replica.db")
    push(hub, [{"id": "a", "name": "A", "qty": 2, "updated_at": T0}])
    sync(replica, hub)
    execute_sql(replica, "UPDATE items SET name='B' WHERE id='a'")
    original = execute_sql(replica, "SELECT id FROM history")
    assert len(original) == 1
    sync(replica, hub)
    sync(replica, hub)
    assert execute_sql(hub.path, "SELECT id FROM history") == original
    assert execute_sql(replica, "SELECT id FROM history") == original


def event(id, old, new, stamp=T1):
    return {
        "id": id,
        "tbl": "items",
        "row_id": "a",
        "col": "name",
        "old": old,
        "new": new,
        "origin": "replica",
        "created_at": stamp,
        "updated_at": stamp,
    }


@pytest.mark.parametrize(
    ("old", "new", "events", "extra"),
    [
        ("A", "C", [event("e1", "A", "B"), event("e2", "B", "C")], []),
        ("A", "A", [event("e1", "A", "B"), event("e2", "B", "A")], []),
        ("D", "C", [event("e1", "A", "B"), event("e2", "B", "C")], [("D", "C")]),
        (None, "C", [event("e1", "A", "B"), event("e2", "B", "C")], []),
    ],
)
def test_attached_history_keeps_original_events_and_only_logs_real_hub_transition(
    hub, old, new, events, extra
):
    if old is not None:
        push(hub, [{"id": "a", "name": old, "updated_at": T0}])
    row = {"id": "a", "name": new, "updated_at": T2}
    out = hub.rows_push("items", list(row), [row], history=events)
    assert out["rejected"] == []
    records = execute_sql(hub.path, "SELECT id, old, new, origin FROM history")
    assert {r["id"] for r in records if r["origin"] == "replica"} == {"e1", "e2"}
    assert [(r["old"], r["new"]) for r in records if r["origin"] == "hub:reconcile"] == extra
    assert len(records) == len(events) + len(extra)
    hub.rows_push("items", list(row), [row], history=events)
    assert len(execute_sql(hub.path, "SELECT * FROM history")) == len(records)


def test_stale_payload_can_replicate_original_history_without_hub_edits(hub):
    push(hub, [{"id": "a", "name": "D", "updated_at": T2}])
    row = {"id": "a", "name": "B", "updated_at": T1}
    assert not hub.rows_push("items", list(row), [row], history=[event("e1", "A", "B")])["rejected"]
    assert execute_sql(hub.path, "SELECT name FROM items") == [{"name": "D"}]
    assert execute_sql(hub.path, "SELECT id FROM history") == [{"id": "e1"}]


def test_rejected_sync_preserves_push_cursor_and_attached_history(hub, tmp_path):
    replica = init(tmp_path / "replica.db")
    push(hub, [{"id": "a", "name": "A", "updated_at": T0}])
    sync(replica, hub)
    before = execute_sql(replica, "SELECT value FROM _sync_state WHERE key='last_push'")
    execute_sql(replica, "UPDATE items SET name='B' WHERE id='a'")
    original = hub.rows_push

    def reject(table, columns, rows, **kwargs):
        if table == "items":
            return {"upserted": 0, "rejected": [{"id": "a", "rule": "write-conflict"}]}
        return original(table, columns, rows, **kwargs)

    hub.rows_push = reject
    assert sync(replica, hub)["rejected"]
    assert execute_sql(replica, "SELECT value FROM _sync_state WHERE key='last_push'") == before
    assert execute_sql(hub.path, "SELECT * FROM history") == []
    hub.rows_push = original
    assert not sync(replica, hub)["rejected"]
    assert len(execute_sql(hub.path, "SELECT * FROM history")) == 1


def test_new_client_replicates_history_when_old_server_ignores_attachment(hub, tmp_path):
    replica = init(tmp_path / "replica.db")
    push(hub, [{"id": "a", "name": "A", "updated_at": T0}])
    sync(replica, hub)
    execute_sql(replica, "UPDATE items SET name='B' WHERE id='a'")
    original_events = execute_sql(replica, "SELECT id FROM history")
    original = hub.rows_push

    def old_server(table, columns, rows, **kwargs):
        # Old hubs ignored extra JSON keys and had no direct-write history.
        if table == "items":
            import json

            from soma import _upsert_sql

            with connect(hub.path) as c:
                c.execute(_upsert_sql(table, columns), (json.dumps(rows),))
            return {"upserted": len(rows), "rejected": []}
        return original(table, columns, rows)

    hub.rows_push = old_server
    assert not sync(replica, hub)["rejected"]
    assert execute_sql(hub.path, "SELECT id FROM history") == original_events
    assert not sync(replica, hub)["rejected"]
    assert execute_sql(hub.path, "SELECT id FROM history") == original_events


def test_sql_cannot_commit_a_different_row_from_validated_row(hub):
    with connect(hub.path) as c:
        c.execute(
            "CREATE TRIGGER clear_name AFTER INSERT ON items BEGIN UPDATE items SET name=NULL WHERE id=NEW.id; END"
        )
    out = push(hub, [{"id": "a", "name": "A", "updated_at": T0}])
    assert out["upserted"] == 0
    assert execute_sql(hub.path, "SELECT * FROM items") == []


def test_invalid_history_id_reuse_rolls_back_row_and_does_not_rewrite_events(hub):
    row = {"id": "a", "name": "B", "updated_at": T1}
    assert not hub.rows_push("items", list(row), [row], history=[event("e1", "A", "B")])["rejected"]
    row.update(name="C", updated_at=T2)
    out = hub.rows_push("items", list(row), [row], history=[event("e1", "B", "C")])
    assert out["rejected"][0]["rule"] == "history"
    assert execute_sql(hub.path, "SELECT name FROM items") == [{"name": "B"}]
    assert execute_sql(hub.path, "SELECT old,new FROM history") == [{"old": "A", "new": "B"}]


@pytest.mark.parametrize(
    ("values", "revisions"),
    [
        ("ABC", "ABC"),
        ("ABAB", "ABAB"),
        ("ABCBC", "ABCBC"),
        ("ABAC", "ABAC"),
        ("DBACACBADCB", "DACACBCB"),
    ],
)
@pytest.mark.parametrize("reverse", [False, True])
def test_I4_duplicate_revisions_share_original_history(hub, values, revisions, reverse):
    push(hub, [{"id": "a", "name": values[0], "updated_at": T0}])
    rows = [
        {"id": "a", "name": name, "updated_at": f"2025-01-{i + 2:02}T00:00:00.000Z"}
        for i, name in enumerate(revisions[1:])
    ]
    events = [event(f"e{i}", old, new) for i, (old, new) in enumerate(pairwise(values))]
    if reverse:
        events.reverse()  # Tied event stamps and random IDs do not establish edit order.
    out = hub.rows_push("items", ["id", "name", "updated_at"], rows, history=events)
    assert out["upserted"] == len(rows)
    assert not out["rejected"]
    assert execute_sql(hub.path, "SELECT name FROM items") == [{"name": values[-1]}]
    assert execute_sql(hub.path, "SELECT id FROM history ORDER BY id") == [
        {"id": f"e{i}"} for i in range(len(events))
    ]
    assert not hub.rows_push("items", ["id", "name", "updated_at"], rows, history=events)[
        "rejected"
    ]
    assert len(execute_sql(hub.path, "SELECT * FROM history")) == len(events)


def test_I4_sparse_revisions_preserve_null_clearing_and_originals(hub):
    push(hub, [{"id": "a", "name": "A", "qty": 1, "updated_at": T0}])
    rows = [{"id": "a", "qty": None, "updated_at": T1}, {"id": "a", "qty": 2, "updated_at": T2}]
    events = [
        {**event("e1", "1", None), "col": "qty"},
        {**event("e2", None, "2"), "col": "qty"},
    ]
    out = hub.rows_push("items", ["id", "qty", "updated_at"], rows, history=events)
    assert out["upserted"] == 2 and not out["rejected"]
    assert execute_sql(hub.path, "SELECT name,qty FROM items") == [{"name": "A", "qty": 2}]
    assert execute_sql(hub.path, "SELECT id,old,new FROM history ORDER BY id") == [
        {"id": "e1", "old": "1", "new": None},
        {"id": "e2", "old": None, "new": "2"},
    ]


def test_I4_one_original_cannot_explain_two_distinct_updates(hub):
    push(hub, [{"id": "a", "name": "A", "updated_at": T0}])
    rows = [
        {"id": "a", "name": name, "updated_at": f"2025-01-0{i + 2}T00:00:00.000Z"}
        for i, name in enumerate("BAB")
    ]
    out = hub.rows_push("items", list(rows[0]), rows, history=[event("e1", "A", "B")])
    assert out["upserted"] == 3 and not out["rejected"]
    records = execute_sql(hub.path, "SELECT id,old,new FROM history")
    assert {"id": "e1", "old": "A", "new": "B"} in records
    assert [(r["old"], r["new"]) for r in records if r["id"] != "e1"] == [("B", "A"), ("A", "B")]


def test_history_search_exhaustion_rolls_back_entire_request(hub, monkeypatch):
    push(
        hub,
        [
            {"id": "a", "name": "A", "updated_at": T0},
            {"id": "b", "name": "before", "updated_at": T0},
        ],
    )
    push(hub, [{"id": "b", "name": "old", "updated_at": T1}])
    before_rows = execute_sql(hub.path, "SELECT * FROM items ORDER BY id")
    before_history = execute_sql(hub.path, "SELECT * FROM history ORDER BY id")
    rows = [
        {"id": "b", "name": "prefix", "updated_at": T2},
        {"id": "a", "name": "B", "updated_at": T1},
        {"id": "a", "name": "C", "updated_at": T2},
        {"id": "c", "name": "suffix", "updated_at": T1},
    ]
    monkeypatch.setattr(catalog, "_HISTORY_SEARCH_LIMIT", 1)
    out = hub.rows_push(
        "items", list(rows[0]), rows, history=[event("e1", "A", "B"), event("e2", "B", "C")]
    )
    assert out["upserted"] == 0
    assert [r["id"] for r in out["rejected"]] == ["b", "a", "a", "c"]
    assert all(r["rule"] == "history-ambiguity" and r["retryable"] for r in out["rejected"])
    assert all("split revisions" in r["message"].lower() for r in out["rejected"])
    assert execute_sql(hub.path, "SELECT * FROM items ORDER BY id") == before_rows
    assert execute_sql(hub.path, "SELECT * FROM history ORDER BY id") == before_history


@pytest.mark.parametrize("old", ["A", "D"])
def test_history_search_cap_keeps_whole_trail_and_proven_divergence(hub, monkeypatch, old):
    push(hub, [{"id": "a", "name": old, "updated_at": T0}])
    monkeypatch.setattr(catalog, "_HISTORY_SEARCH_LIMIT", 0)
    row = {"id": "a", "name": "C", "updated_at": T2}
    out = hub.rows_push(
        "items", list(row), [row], history=[event("e1", "A", "B"), event("e2", "B", "C")]
    )
    assert out["upserted"] == 1 and not out["rejected"]
    assert execute_sql(hub.path, "SELECT name FROM items") == [{"name": "C"}]
    records = execute_sql(hub.path, "SELECT id,old,new,origin FROM history")
    assert {r["id"] for r in records if r["origin"] == "replica"} == {"e1", "e2"}
    extra = [(r["old"], r["new"]) for r in records if r["origin"] == "hub:reconcile"]
    assert extra == ([] if old == "A" else [("D", "C")])
    assert len(records) == (2 if old == "A" else 3)


def test_I5_sync_snapshots_rows_and_events_together(hub, tmp_path, monkeypatch):
    replica = init(tmp_path / "replica.db")
    push(hub, [{"id": "a", "name": "A", "updated_at": T0}])
    sync(replica, hub)
    original = hub.rows_pull
    edited = False

    def pull(table, columns, since):
        nonlocal edited
        if not edited:
            edited = True
            execute_sql(replica, "UPDATE items SET name='B' WHERE id='a'")
        return original(table, columns, since)

    with monkeypatch.context() as m:
        m.setattr(hub, "rows_pull", pull)
        assert not sync(replica, hub)["rejected"]
    assert execute_sql(hub.path, "SELECT name FROM items") == [{"name": "A"}]
    assert execute_sql(hub.path, "SELECT * FROM history") == []
    assert not sync(replica, hub)["rejected"]
    assert execute_sql(hub.path, "SELECT name FROM items") == [{"name": "B"}]
    assert execute_sql(hub.path, "SELECT old,new FROM history") == [{"old": "A", "new": "B"}]
    assert execute_sql(hub.path, "SELECT id FROM history") == execute_sql(
        replica, "SELECT id FROM history"
    )


def test_I5_local_write_between_snapshot_reads_is_deferred(hub, tmp_path, monkeypatch):
    import sqlite3

    import soma

    replica = init(tmp_path / "replica.db")
    push(hub, [{"id": "a", "name": "A", "updated_at": T0}])
    sync(replica, hub)
    edited = False
    blocked = []

    def interleave(sql):
        nonlocal edited
        if not edited and sql.startswith('SELECT * FROM "items" WHERE updated_at >'):
            edited = True
            with connect(replica) as writer:
                writer.execute("PRAGMA busy_timeout=0")
                try:
                    writer.execute("UPDATE items SET name='B' WHERE id='a'")
                except sqlite3.OperationalError as exc:
                    blocked.append(str(exc))

    def traced_connect(path, manual_tx=False):
        conn = connect(path, manual_tx)
        if path == replica:
            conn.set_trace_callback(interleave)
        return conn

    original_pull = hub.rows_pull
    retried = False

    def pull(table, columns, since):
        nonlocal retried
        if not retried:
            retried = True
            execute_sql(replica, "UPDATE items SET name='B' WHERE id='a'")
        return original_pull(table, columns, since)

    with monkeypatch.context() as m:
        m.setattr(soma, "connect", traced_connect)
        m.setattr(hub, "rows_pull", pull)
        assert not sync(replica, hub)["rejected"]
    assert edited
    assert blocked == ["database is locked"]
    assert execute_sql(hub.path, "SELECT name FROM items") == [{"name": "A"}]
    assert execute_sql(hub.path, "SELECT * FROM history") == []
    assert not sync(replica, hub)["rejected"]
    assert execute_sql(hub.path, "SELECT name FROM items") == [{"name": "B"}]
    assert execute_sql(hub.path, "SELECT old,new FROM history") == [{"old": "A", "new": "B"}]
    assert execute_sql(hub.path, "SELECT id FROM history") == execute_sql(
        replica, "SELECT id FROM history"
    )


@pytest.mark.parametrize("actual", ["invalid", T2, None])
@pytest.mark.parametrize("operation", ["INSERT", "UPDATE"])
def test_I9_actual_uncataloged_timestamp_must_match_approved_edit(hub, actual, operation):
    with connect(hub.path) as c:
        c.execute("CREATE TABLE raw (id TEXT PRIMARY KEY, name TEXT, updated_at TEXT)")
        if operation == "UPDATE":
            c.execute("INSERT INTO raw VALUES ('a', 'A', ?)", (T0,))
        stamp = "NULL" if actual is None else f"'{actual}'"
        c.execute(
            f"CREATE TRIGGER corrupt_stamp AFTER {operation} ON raw WHEN NEW.id='a' "
            f"BEGIN UPDATE raw SET updated_at={stamp} WHERE id=NEW.id; END"
        )
    rows = [
        {"id": "a", "name": "B", "updated_at": T1},
        {"id": "b", "name": "valid", "updated_at": T1},
    ]
    out = hub.rows_push(
        "raw", list(rows[0]), rows, history=[{**event("e1", "A", "B"), "tbl": "raw"}]
    )
    assert out["upserted"] == 1
    assert out["rejected"][0]["id"] == "a"
    assert out["rejected"][0]["col"] == "updated_at"
    expected = ([{"id": "a", "name": "A", "updated_at": T0}] if operation == "UPDATE" else []) + [
        rows[1]
    ]
    assert execute_sql(hub.path, "SELECT * FROM raw ORDER BY id") == expected
    assert execute_sql(hub.path, "SELECT * FROM history") == []
