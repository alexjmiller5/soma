"""soma.table_pull: the Python twin of core/src/table-pull.js (whose tests run
against the real Worker). Here a small sqlite hub answers the two routes."""

import sqlite3

import pytest

from soma.table_pull import HubError, pull_table, pull_tables


def at(n):
    return f"2026-10-01T00:00:{n:02d}.000Z"


class Hub:
    def __init__(self, batch_rows=5000):
        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        for t in ("bookmarks", "notes"):
            self.db.execute(
                f"CREATE TABLE {t}(id TEXT PRIMARY KEY, url TEXT, title TEXT, body TEXT, deleted_at TEXT, hub_at TEXT)"
            )
        self.batch_rows, self.routes = batch_rows, []

    def put(self, table, id, hub_at, **values):
        cols = ["id", "hub_at", *values]
        self.db.execute(
            f"INSERT INTO {table}({','.join(cols)}) VALUES ({','.join('?' * len(cols))}) "
            f"ON CONFLICT(id) DO UPDATE SET {','.join(f'{c}=excluded.{c}' for c in cols[1:])}",
            [id, hub_at, *values.values()],
        )

    def post(self, route, body):
        self.routes.append(route)
        if route == "/v1/cursor":
            marks, at_mark = {}, {}
            for t in body["tables"]:
                m = self.db.execute(f"SELECT max(hub_at) FROM {t}").fetchone()[0] or ""
                marks[t] = m
                if m:
                    at_mark[t] = self.db.execute(
                        f"SELECT count(*) FROM {t} WHERE hub_at = ?", [m]
                    ).fetchone()[0]
            return {
                "tables": marks,
                "at_mark": at_mark,
                "pull_batch": {"items": 50, "rows": self.batch_rows, "bytes": 1 << 22},
            }
        pages = []
        for item in body["batch"]:
            rows = [
                dict(r)
                for r in self.db.execute(
                    f"SELECT {','.join(item['columns'])} FROM {item['table']} WHERE (? = '' OR hub_at >= ?) AND id > ? ORDER BY id LIMIT ?",
                    [item["since"], item["since"], item.get("after", ""), item["limit"]],
                )
            ]
            pages.append(
                {
                    "rows": rows,
                    "next_cursor": rows[-1]["id"] if len(rows) == item["limit"] else None,
                }
            )
        return {"batch": pages}


COLUMNS = ["id", "url", "title"]


def pull(hub, state, columns=COLUMNS, endpoint="https://hub.test/"):
    return pull_table(endpoint, "token", "bookmarks", columns, state, post=hub.post)


def test_first_round_is_full_and_a_quiet_round_is_one_cursor_request():
    hub = Hub()
    hub.put("bookmarks", "a", at(1), url="https://a.test/", title="A")
    hub.put("bookmarks", "b", at(2), url="https://b.test/", title="B")
    first = pull(hub, None)
    assert first["full"] is True
    assert [(r["id"], r["title"]) for r in first["rows"]] == [("a", "A"), ("b", "B")]
    assert hub.routes == ["/v1/cursor", "/v1/rows/pull"]
    hub.routes.clear()
    quiet = pull(hub, first["state"])
    assert (quiet["full"], quiet["rows"], quiet["deleted"], quiet["tombstones"], quiet["requests"]) == (
        False,
        [],
        [],
        [],
        1,
    )
    assert quiet["state"] == first["state"]


def test_later_rounds_return_arrivals_and_tombstones():
    hub = Hub()
    hub.put("bookmarks", "a", at(1), title="A")
    hub.put("bookmarks", "b", at(2), title="B")
    state = pull(hub, None)["state"]
    hub.put("bookmarks", "a", at(3), title="A2")
    hub.put("bookmarks", "c", at(3), title="C")
    hub.put("bookmarks", "b", at(4), deleted_at=at(4))
    round_ = pull(hub, state)
    assert round_["full"] is False
    assert [(r["id"], r["title"]) for r in round_["rows"]] == [("a", "A2"), ("c", "C")]
    assert round_["deleted"] == ["b"]
    # A consumer that keeps deleted rows (to recognize them later) gets their columns too.
    assert [(r["id"], r["title"], r["deleted_at"]) for r in round_["tombstones"]] == [
        ("b", "B", at(4))
    ]


def test_a_late_commit_on_the_mark_is_fetched_next_round():
    hub = Hub()
    hub.put("bookmarks", "a", at(5), title="A")
    state = pull(hub, None)["state"]
    hub.put("bookmarks", "late", at(5), title="Late")
    round_ = pull(hub, state)
    assert [r["id"] for r in round_["rows"]] == ["a", "late"]
    assert pull(hub, round_["state"])["rows"] == []


def test_backwards_mark_other_columns_or_another_hub_restart_in_full():
    hub = Hub()
    hub.put("bookmarks", "a", at(1), title="A")
    hub.put("bookmarks", "b", at(2), title="B")
    state = pull(hub, None)["state"]
    hub.db.execute("DELETE FROM bookmarks WHERE id = 'b'")
    restarted = pull(hub, state)
    assert restarted["full"] is True and [r["id"] for r in restarted["rows"]] == ["a"]
    widened = pull(hub, restarted["state"], columns=["id", "url"])
    assert widened["full"] is True
    assert (
        pull(hub, widened["state"], columns=["id", "url"], endpoint="https://other.test")["full"]
        is True
    )


def test_tables_share_requests_pages_walk_and_empty_tables_stay_quiet():
    hub = Hub(batch_rows=4)
    for i in range(5):
        hub.put("bookmarks", f"r{i}", at(1), title=str(i))
    tables = {"bookmarks": COLUMNS, "notes": ["id", "body"]}
    first = pull_tables("https://hub.test", "token", tables, None, post=hub.post)
    assert len(first["changes"]["bookmarks"]["rows"]) == 5
    assert first["changes"]["notes"] == {"full": True, "rows": [], "deleted": [], "tombstones": []}
    # Two tables share the 4-row budget; once notes is done bookmarks gets all of it.
    assert hub.routes == ["/v1/cursor", "/v1/rows/pull", "/v1/rows/pull"]
    hub.routes.clear()
    hub.put("notes", "n", at(9), body="hello")
    nxt = pull_tables("https://hub.test", "token", tables, first["state"], post=hub.post)
    assert nxt["changes"]["bookmarks"]["rows"] == []
    assert (
        nxt["changes"]["notes"]["full"] is True
        and nxt["changes"]["notes"]["rows"][0]["body"] == "hello"
    )
    assert hub.routes == ["/v1/cursor", "/v1/rows/pull"]


@pytest.mark.parametrize(
    "answers,message",
    [
        ([{"tables": {}}], "invalid cursor response"),
        (
            [{"tables": {"bookmarks": "yesterday"}, "pull_batch": {"items": 50, "rows": 5000}}],
            "invalid cursor response",
        ),
        (
            [
                {
                    "tables": {"bookmarks": at(1)},
                    "at_mark": {"bookmarks": 1},
                    "pull_batch": {"items": 50, "rows": 1},
                },
                {
                    "batch": [
                        {
                            "rows": [{"id": "x", "hub_at": at(1), "deleted_at": None}],
                            "next_cursor": "x",
                        }
                    ]
                },
                {
                    "batch": [
                        {
                            "rows": [{"id": "a", "hub_at": at(1), "deleted_at": None}],
                            "next_cursor": "a",
                        }
                    ]
                },
            ],
            "invalid pull response",
        ),
    ],
)
def test_malformed_answers_fail_the_round(answers, message):
    replies = iter(answers)
    with pytest.raises(HubError, match=message):
        pull_table(
            "https://hub.test",
            "token",
            "bookmarks",
            COLUMNS,
            None,
            post=lambda route, body: next(replies),
        )
