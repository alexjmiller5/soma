"""Repeated reads of hub tables for a consumer that keeps no replica.

The Python twin of soma-core's `core/src/table-pull.js`: `/v1/cursor` once per
round, then only tables whose mark moved, pulled from the held cursor
(`hub_at >= since`) in batches. Standard library only, so consumers vendor
this one file. The caller stores `state` (small JSON) between rounds and
applies each table's changes: `full` replaces its copy with `rows`; otherwise
upsert `rows` and drop the `deleted` ids (`tombstones` carries those rows'
pulled columns for a consumer that keeps deleted rows). Contract:
docs/consumer-access.md.
"""

import json
import re
import urllib.error
import urllib.request

MARK = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z")


class HubError(RuntimeError):
    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


def http_post(endpoint, token, headers=None, timeout=60):
    """A `post(route, body)` over urllib. Cloudflare's bot check refuses the
    default Python-urllib agent, so a real User-Agent is always sent."""

    def post(route, body):
        request = urllib.request.Request(
            endpoint + route,
            data=json.dumps(body).encode(),
            method="POST",
            headers={
                "User-Agent": "soma-table-pull/1",
                **(headers or {}),
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.load(response)
        except urllib.error.HTTPError as e:
            raise HubError(
                f"hub {route} HTTP {e.code}: {e.read().decode(errors='replace')[:300]}", e.code
            ) from e

    return post


def pull_tables(endpoint, token, tables, state, *, watch=(), post=None, headers=None):
    base = str(endpoint).rstrip("/")
    names = list(tables)
    if not names:
        raise ValueError("name at least one table")
    post = post or http_post(base, token, headers)
    # id/hub_at/deleted_at drive the cursor and tombstones, so every pull carries them.
    want = {t: list(dict.fromkeys([*tables[t], "id", "hub_at", "deleted_at"])) for t in names}
    held = (
        (state or {}).get("tables") or {}
        if (state or {}).get("v") == 1 and state.get("endpoint") == base
        else {}
    )
    requests = 0

    def call(route, body):
        nonlocal requests
        requests += 1
        return post(route, body)

    marks = call("/v1/cursor", {"tables": list(dict.fromkeys([*names, *watch]))})
    batch = (marks or {}).get("pull_batch") or {}
    if (
        not isinstance((marks or {}).get("tables"), dict)
        or any(
            not isinstance(marks["tables"].get(t), str)
            or not (marks["tables"][t] == "" or MARK.fullmatch(marks["tables"][t]))
            for t in [*names, *watch]
        )
        or not all(
            isinstance(batch.get(k), int) and not isinstance(batch.get(k), bool) and batch[k] > 0
            for k in ("items", "rows")
        )
    ):
        raise HubError("invalid cursor response")

    changes, nxt, walks = {}, {}, []
    for t in names:
        key, mark = ",".join(want[t]), marks["tables"][t]
        prior = held.get(t) if (held.get(t) or {}).get("columns") == key else None
        # A mark behind our cursor: the table was replaced, restored or its
        # newest row purged. Only a full pull can tell what is gone.
        since = prior["since"] if prior and mark >= prior["since"] else ""
        # Inclusive pulls re-read the mark; it is quiet while the hub holds as
        # many rows at the mark as we received there.
        if (
            prior
            and since == mark
            and (mark == "" or (marks.get("at_mark") or {}).get(t) == prior["n"])
        ):
            changes[t] = {"full": False, "rows": [], "deleted": [], "tombstones": []}
            nxt[t] = prior
        else:
            walks.append(
                {
                    "t": t,
                    "key": key,
                    "since": since,
                    "mark": mark,
                    "rows": [],
                    "after": None,
                    "done": False,
                }
            )

    open_ = walks
    while open_:
        asked = open_[: batch["items"]]
        limit = batch["rows"] // len(asked)
        reply = call(
            "/v1/rows/pull",
            {
                "batch": [
                    {
                        "table": w["t"],
                        "columns": want[w["t"]],
                        "since": w["since"],
                        "limit": limit,
                        **({"after": w["after"]} if w["after"] else {}),
                    }
                    for w in asked
                ]
            },
        )
        pages = (reply or {}).get("batch")
        # Past its byte budget the hub answers a prefix of the pulls asked.
        if not isinstance(pages, list) or not pages or len(pages) > len(asked):
            raise HubError("invalid pull response")
        for w, page in zip(asked, pages):
            rows, cursor = (page or {}).get("rows"), (page or {}).get("next_cursor")
            if (
                not isinstance(rows, list)
                or any(not isinstance(r, dict) or not isinstance(r.get("id"), str) for r in rows)
                or (
                    cursor is not None
                    and (not isinstance(cursor, str) or cursor <= (w["after"] or "") or not rows)
                )
            ):
                raise HubError("invalid pull response")
            w["rows"].extend(rows)
            w["after"], w["done"] = cursor, cursor is None
        open_ = [w for w in open_ if not w["done"]]

    for w in walks:
        tombstones = [r for r in w["rows"] if r.get("deleted_at") is not None]
        changes[w["t"]] = {
            "full": w["since"] == "",
            "rows": [r for r in w["rows"] if r.get("deleted_at") is None],
            "deleted": [r["id"] for r in tombstones],
            "tombstones": tombstones,
        }
        nxt[w["t"]] = {
            "columns": w["key"],
            "since": w["mark"],
            "n": sum(r.get("hub_at") == w["mark"] for r in w["rows"]),
        }
    # A watched table is marked, never pulled: a consumer reading only a `where`
    # slice of it re-reads the slice when this pair moves.
    watched = {
        t: {"mark": marks["tables"][t], "n": (marks.get("at_mark") or {}).get(t, 0)} for t in watch
    }
    return {
        "changes": changes,
        "state": {"v": 1, "endpoint": base, "tables": nxt},
        "requests": requests,
        "watched": watched,
    }


def pull_table(endpoint, token, table, columns, state, **options):
    out = pull_tables(endpoint, token, {table: columns}, state, **options)
    return {
        **out["changes"][table],
        "state": out["state"],
        "requests": out["requests"],
        "watched": out["watched"],
    }
