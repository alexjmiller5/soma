# soma

A schema-agnostic personal data store: local-first SQLite with an
agent-friendly CLI, and an optional sync service. Think "headless Notion" -
you define your own tables at runtime, your data lives in a SQLite file on
your own machine, AI agents query and edit it with plain SQL, and every
device stays a complete replica whether or not the network is up.

The software is generic: it ships zero personal schema. Your tables, columns,
and rows are *state*, created entirely through the installed CLI - never by
editing this repo.

## Install

```bash
nix profile install github:alexjmiller5/soma
```

Or use the exported Home Manager module on macOS. It installs the CLI,
DuckDB and a supervised background runner. Sync starts **off**:

```nix
imports = [ soma.homeModules.default ];
services.soma.enable = true;
```

Optional defaults: `hubUrl`, `cli.tokenCommand`, and `watch.tokenCommand`.
The two credential commands are independent; neither is required. Add any
background command's dependencies through `watch.packages`.
`watch.enable = false` omits the runner entirely.

An install made before the rename (data in `~/.local/share/life-data`, the
`life` command) is adopted on the first `soma` run: the data dir moves, the
hosted hub's new hostname replaces the old one and the device stays enrolled.

## Use

```bash
soma init                                  # create the data dir + database
soma path                                  # print the database path
soma table create people name:text birthday:text \
  --description 'name=Display name.' --description 'birthday=Source birthday text.'
soma sql "INSERT INTO people (name) VALUES ('Ada')"
soma sql "SELECT * FROM people"            # results as JSON
soma sql "ALTER TABLE people ADD COLUMN likes TEXT"
soma table rename people humans            # the ONLY way to rename a table
soma sql "SELECT * FROM history WHERE tbl = 'humans' ORDER BY created_at"
soma export > backup.sql                   # portable dump, no cloud involved
```

Every statement is plain SQLite SQL. Everything above works offline, forever,
with no account and no server.

## Sync (optional)

```bash
soma sync                    # one round trip
soma watch                   # sync in this terminal until interrupted
soma background enable       # enable the installed background runner
soma background disable      # finish the current round, then stop syncing
soma background status       # enabled, running, last success/error and counts
```

`soma watch` and the background runner push a local write within about a
second and pull a remote edit within a couple of seconds: they hold a long
poll on the hub's change signal and run a round as soon as anything is
committed there. While the hub cannot be reached that way they sync every
`--poll` seconds (30 by default); with the signal live, a round every ten
minutes is the safety net. A failed round is retried after 15 s, doubling to
at most two minutes (5 s when another local writer held the database); a
round that must fetch the credential again backs off up to an hour.

```http
GET /v1/changes?since=<seq>&wait=<0-25>
```

Any token with `tables:read` (or `full`) may call it. It answers `{"seq": n}`
at once when `since` is absent or differs from the hub's change sequence,
otherwise when the next row or schema commit moves it or `wait` seconds pass.
Only a commit that changes rows or schema moves the sequence; no-op and
rejected writes do not. The sequence says only "something changed": run an
ordinary sync round, then poll again with the new value.

On a new Mac, sign in through the browser and then enable sync:

```bash
soma login --name "My laptop"
soma background enable
```

Soma opens the hub's Cloudflare Access email approval page. After approval,
it saves an independently revocable device token in macOS Keychain. No other
Soma device, password-manager vault, service account, or provider token is
needed. Recovering after losing every Mac means installing Soma again and
repeating these steps using the owner's email account. Login and sync opt-in
are separate choices.

The browser receives a public fingerprint, never the bearer token. An
unapproved fingerprint link does not expire on the server; the CLI waits up to
five minutes. Only approve a link from a login you are currently performing.
A fingerprint alone grants no access. Device management at `<hub>/login/devices`
revokes Soma API credentials. It does not sign an owner out of Cloudflare Access:
for a lost device with a usable browser session, the service operator must also
revoke that identity's Access sessions and secure the email account. The hosted
service currently admits one owner and one dataset; it is not multi-user signup.

Keychain may require foreground macOS approval. Background reads never prompt:
if access requires interaction, the runner reports a sanitized OS error and
retries. Unlocking the screen and allowing the executable to read the Keychain
item are separate requirements. Disabling sync retains the credential.

`soma logout` revokes the saved device token at its hub before removing the
Keychain item. Failed revocation retains the local token so logout can be
retried. For an existing externally provisioned device token, use
`soma login --token-stdin`; admin tokens are rejected. Pipe credentials from
a trusted provider, never put them in arguments or shell history.

### Consumer enrollment

Applications other than your own `soma` CLI and Iris enroll with a named
profile: a grant set the hub operator configures in `ENROLLMENT_PROFILES`. The
approval page shows the application label and every grant; the resulting token
carries exactly those grants and nothing broader. The full standard is
[docs/consumer-access.md](docs/consumer-access.md).

```bash
soma login --profile reader-v1 --name "Reader"   # this Mac, token in Keychain
```

A server consumer is enrolled by its operator in two steps, so the approval
link can wait for the owner:

```bash
soma login --profile sync-v1 --name "Sync server" --start pending.json
# prints {"approval_url", "approval_code", "state_file"}; send the URL to the owner
soma login --claim pending.json            # one check; fails until approved
soma login --claim pending.json --wait     # or poll every 5 s for up to 300 s
```

`--start` writes a fresh candidate token to a new `0600` state file (it never
overwrites one) and contacts nothing. `--claim` prints only the approved token
on stdout, then deletes the state file; store it straight into the consumer's
own secret store. An approval that is not exactly the requested profile is
revoked. Neither step touches Keychain, so both work on any OS.

`--hub-url https://your-hub.example.com` selects a self-hosted instance.
Once a data directory has synced over HTTP, it is bound to that endpoint.
Use a fresh `SOMA_DATA_DIR` for a different hub; existing cursors and data
are never silently reused against another service. A replica without a recorded
endpoint performs one full sync to establish trustworthy cursors. This first
round can take longer for a large existing database. Pulls request pages of 200;
a failed page leaves the sync cursors unchanged for retry. A page or push chunk
failing with a server error, timeout or dropped connection is retried up to
three times (after 1, 4 and 15 seconds) before the round fails.

Alternatively, pass `--token-command 'credential-tool read hub-token'`.
It runs in the daemon's environment; it must work without a terminal.
`SOMA_HUB_TOKEN` in that environment takes precedence. No password manager,
vault, or service account is required by Soma. A credential command is read
once per enabled session/configuration; a rejected credential is reloaded
with backoff. Never put a token literal in a command or shell history.

The Home Manager module owns installation and login startup. The CLI owns
the mutable on/off setting, which survives process restarts and Nix rebuilds.
With only the standalone package installed, `background status` reports
`running: false`; install the module for automatic login startup, or run
`soma background run` under your own supervisor. The runner stays idle
while disabled, making no hub or credential requests. Only one runner can
hold a data directory at a time. Failures retry after 60 seconds, doubling
to a maximum of one hour. Re-enabling resets that wait. `last_success`
advances only after a round with no rejected rows. The status output never
includes row payloads or credential-command output; the daemon log adds the
first 300 characters of a server, timeout or connection failure's message.

Sync is state-based and last-write-wins per row on `updated_at`; deletes are
soft (`UPDATE ... SET deleted_at = updated_at`) so tombstones propagate. A
hard `DELETE` does not. Schema changes replay from `_schema_log`, so a new
device pulls tables and rows with `soma init` followed by `soma sync`.

When content must disappear rather than be marked deleted (a soft-deleted
row and the `history` table both keep the old text), use `soma purge`:

```bash
soma purge notes 3f2a...                 # the row, its history and provenance edges
soma sql "UPDATE notes SET body = '[redacted]' WHERE id = '3f2a...'"
soma purge notes 3f2a... --col body      # only the old values of one column
```

A purge writes a marker to the `purges` table naming the table, row and
column, never the content. The marker syncs like a row: the hub and every
replica delete what it covers, and the hub silently drops copies stamped at
or before the marker that an out-of-date device pushes later. A copy written
after the marker (a re-import from the source) is new data and is kept;
purge again to remove it. Hub backups keep old copies until they expire.

Only one sync round runs per database, including manual and background calls.
The push checkpoint uses the local clock captured with a consistent snapshot;
it never advances from a remote row's future revision. The hub stamps arrivals
inside the committing transaction. Inclusive boundaries replay equal timestamps
without duplicating IDs or original history events.

Upgrading an older checkpoint triggers one reconciliation: a full pull that
compares each page with the local rows in the same id range, then pushes only
the rows the hub lacks or holds older, plus pending local edits. Progress is
saved per page, so an interrupted recovery resumes where it stopped; a rejected
one rescans from the start. Successful completion records the upgrade so normal
rounds remain incremental. This can take longer than an ordinary sync on a
large replica. It does not delete history or rebuild
rows from guesses. A detected local clock rollback also forces a full push.

`updated_at` remains the conflict revision. Python CLI writes also record local
dirty identities in the same transaction, so an import carrying an old
`updated_at` reaches the hub without rewriting its source timestamp. Sync keeps
those identities until the frozen changes are acknowledged; an interrupted or
rejected round and edits made during network requests remain pending. Pulled
rows do not enter this local queue. Timestamp scanning remains a compatibility
fallback for other writers, which must maintain current revisions. A historical
revision still cannot overwrite a newer hub row, and equal revisions of the
same row do not overwrite one another.

`config.json` in the data directory provides optional installation defaults:

```json
{
  "hub_url": "https://your-hub.example.com",
  "token_cmd": "credential-tool read interactive-token",
  "background_token_cmd": "credential-tool read device-token"
}
```

The interactive client also accepts `token` in config and extra proxy
`headers`; `SOMA_HUB_TOKEN` and `SOMA_HUB_URL` override file configuration.
Browser login selects the saved device session ahead of installation credential
commands. Logout suppresses implicit fallback until an explicit authentication
choice. An explicitly set `SOMA_HUB_TOKEN` remains an operator override.
Background credential commands are separate from interactive `token`/`token_cmd`.
User choices made through the CLI live in `background.json`; execution
status lives in `background-status.json`. Neither contains saved tokens.

## Self-hosting the hub

The hub is a Cloudflare Worker in `worker/`, storing the canonical replica in
one D1 and writing backups to R2. Token state lives in a separate D1 binding
named `AUTH_DB`; the user-controlled data D1 is never used as the auth store.
The bindings are declared in `worker/wrangler.jsonc`.

```bash
cd worker && bunx wrangler@4 deploy
bunx wrangler@4 secret put HUB_TOKEN     # operator/admin secret, never a consumer device credential
../scripts/cf-r2-lifecycle.py            # apply tiered backup retention
```

Before the first deploy, create the auth D1, add its id as the `AUTH_DB`
binding, and set the non-secret `LOGIN_ACCESS_AUD` variable to the audience
returned by `scripts/cf-login.py`. If the existing hub has `_tokens`, run
`scripts/migrate-auth-registry.py` once before switching clients to the new
worker. The Access application protects `<domain>/login` and its children
with email OTP; `/v1` remains bearer-token authenticated.

Browser clients (a web app on its own origin) need that origin listed in the
non-secret `CORS_ORIGINS` variable, comma-separated exact origins. Only listed
origins can read API responses; the `/login` pages never answer CORS.

Point clients at it with `hub_url`, and you own the whole loop.

Services that only initialize deterministic rows can use the optional
[create-only origin contract](docs/superpowers/specs/2026-10-06-create-only-origin.md).
The operator configures `ROW_CREATION_POLICIES` in Worker secret storage and mints
a dedicated credential with the exact policy revision grant through the token
API. Policy configuration and consumer credentials are separate from native
reader enrollment. With no configured policy/grant, the session advertises no
creation capability. Clients hold only the endpoint, their own credential and
the expected public policy receipt, never the server policy or provider facts.

### Backups

The hub's daily cron exports each database (the data database as `soma-…`,
the auth registry as `auth-…`) through D1's export API and streams the SQL,
gzipped, to R2, writing into the prefix matching how long that copy should
live:

| Prefix     | Written | Kept |
|------------|---------|------|
| `daily/`   | daily   | 35 days |
| `weekly/`  | Sundays | 190 days |
| `monthly/` | the 1st | 400 days |
| `yearly/`  | Jan 1   | forever |

Retention is enforced by R2 lifecycle rules; `scripts/cf-r2-lifecycle.py` is
their source of truth. The export needs the `BACKUP_API_TOKEN` Worker secret,
a Cloudflare API token with D1 Write (`scripts/provision.py` mints it). A
failed run fails the cron and posts a critical `backup.failed` notification to
the hub's feed (pushed to enrolled devices); the first good run afterwards
posts `backup.recovered`. `POST /v1/backup` with a full or operator token runs
a backup on demand.

Restore a copy locally inside one transaction (the export carries none, and
committing each statement separately takes hours):

```bash
{ echo 'BEGIN;'; gunzip -c soma-….sql.gz; echo 'COMMIT;'; } | sqlite3 restored.db
```

Restore into a fresh D1 database through `scripts/d1-fit-dump.py`, which
splits rows over D1's 100 KB statement limit (the export writes each row as
one INSERT, and D1 refuses longer ones with `SQLITE_TOOBIG`):

```bash
gunzip -c soma-….sql.gz | scripts/d1-fit-dump.py > dump.sql
wrangler d1 execute <new-db> --remote --file dump.sql
```

D1 Time Travel separately covers each database under its configured plan.

## Streams (append-only data)

Tables hold rows you edit; **streams** hold append-only, timestamped events -
location pings, sensor readings, anything written once and read analytically.
Streams are hub-backed by nature (the events are born remote):

```bash
echo '{"lat": 42.36, "lon": -71.06, "tst": 1756789200}' | soma stream append location
soma stream tail location        # the freshest record
soma archive query "SELECT * FROM soma.events WHERE stream = 'location' LIMIT 10"
```

Any client that can POST JSON can feed a stream - e.g. OwnTracks in HTTP mode
pointed at `<hub>/v1/streams/location/append` with the token as its Basic-auth
password. The hub stores every event verbatim as a landing object (raw is
sacred, never deleted) and tees it into a managed pipeline that builds an
Apache Iceberg table (`soma.events`) with automatic compaction. Queries run
server-side over that table; `--raw` instead runs local DuckDB against the
raw landing/parquet objects (needs `duckdb` on PATH).

On Cloudflare that machinery is Pipelines + R2 Data Catalog + R2 SQL (open
beta, Workers Paid); self-hosters get the landing/tail/manifest endpoints
regardless, and everything is rebuildable from landing.

## Where data lives

`$SOMA_DATA_DIR` if set, else `$XDG_DATA_HOME/soma`, else
`~/.local/share/soma`. The database is a single `soma.db` file - copying
it is a complete backup. Never put the data dir inside a file-sync folder
(iCloud Drive, Dropbox): file-level sync corrupts SQLite WAL databases.

## Design

- **Tables created via `soma table create` get sync-ready columns
  automatically**: `id` (random 128-bit hex), `created_at`, `updated_at`
  (trigger-maintained), `deleted_at`. ISO 8601 UTC, millisecond precision.
  Repeat `--description COLUMN=TEXT` to document each supplied column.
  The table, timestamp trigger, catalog definitions and schema log commit
  together; a rejected definition leaves none of them behind.
- **Catalog policy is data.** Enforced table invariants on
  `catalog_properties` apply to `soma property set`, raw metadata writes and
  hub pushes. A rule using `changed` can require descriptions on new or edited
  definitions while leaving ordinary data edits available for older tables.
  `soma check` evaluates `changed` against the full table to report existing
  gaps. Configure naming and documentation rules through `soma rule set`;
  the application ships no user-specific catalog policy.
- **`history`** records every edit to every cataloged table, one row per
  changed cell (`tbl`, `row_id`, `col`, `old`, `new`, `origin` = hostname,
  `created_at` = when), in the same transaction as the edit. Updates only:
  an insert is `created_at` plus the row, and a cell's first change keeps its
  original value in `old`, so the full timeline is reconstructible. It syncs
  like any table.
- **`soma table rename OLD NEW`** renames a table and every reference to it
  (catalog properties and refs, rule SQL, provenance, history) in one
  transaction, as logged DDL. A raw `ALTER TABLE … RENAME TO` through
  `soma sql` is refused because it would leave those references dangling.
- **`_schema_log`** records every DDL statement in order; replicas replay it.
- **`_sync_state`** holds the sync cursors.
- The client is pure Python standard library - no runtime dependencies.

## Importing data

There is no importer command by design: an agent (or you) maps any source
into the generic primitives - `soma table create`, then transform records to
JSON and pipe them into `soma insert <table>`. Use source record ids as row
`id`s so re-imports stay idempotent and cross-source relations survive.

### Hub write contract

Use `POST /v1/rows/insert` for creation that must never overwrite an existing
ID. It accepts `{table, columns, rows}` and returns `{inserted, existing,
rejected}`. Existing IDs, including tombstones, keep every stored field and
timestamp; their ignored initializer values are not validated. New rows must
pass the normal catalog contract and supply a millisecond UTC `updated_at`.
IDs must be unique nonempty strings within the request. History attachments
are not supported. Both `LocalHub.rows_insert` and `HttpHub.rows_insert`
expose this operation, using the existing `tables:write` permission.

Only committed insertion receipts count as new rows. Retrying after a lost
response can return `existing`, so callers cannot infer who created that row.
Separate chunks can commit before a later request fails. An older hub without
this route fails closed; creation callers must never fall back to upsert.
Deploy the route before releasing clients that require it.

`/v1/rows/push` retains sparse `columns`/`rows` patches and per-row rejection.
Every row must supply valid `updated_at` in exact `YYYY-MM-DDTHH:MM:SS.sssZ`
form, even on uncataloged tables. Only strictly newer revisions change stored
values. Required properties judge the merged row; explicit null clears optional
fields. Inserts validate SQLite defaults as well as supplied values; numeric
strings retain SQLite INTEGER/REAL coercion. References and dynamic options are
checked at each mutation, including changes earlier in the batch. Enforced catalog invariants and history are transactional on both hubs;
advisory rules remain advisory.

Use `POST /v1/rows/patch` for conditional edits to one existing row. Send
`{table, id, values, expected_revision: {updated_at, hub_at}}`, using the
revision from a prior row read (`hub_at: null` for a table without that clock).
The response is `{id, revision: {updated_at, hub_at}}` from the committed
transaction. The server advances the edit clock, including under client clock
skew, and validates sparse values, references, invariants and history together.
Identity, creation/edit/arrival clocks and tombstones cannot be patched here.
Empty or malformed patches return 400; a stale revision, missing row or
tombstone returns 409 `revision_conflict`; invalid values return 422
`validation_failed`. A failed write changes neither the row nor its history
or durable change events. After a timeout or conflict, reread and recompute
the intended edit; never fall back to an unconditional push.

The session capability `conditional_patch: "revision-v1"` advertises this
operation. Broad `tables:write` and exact `tables:write:<table>` grants are
supported; narrow callers retain all table eligibility checks. A write-only
credential receives the revision receipt, not the row's other values.

An optional `history` array carries original replica events for submitted rows,
using the history-table shape and original IDs. Matching IDs are idempotent;
conflicting reuse rejects the row. Original events that explain a cell transition
replace an aggregate hub entry, including several ordered revisions of one ID. If a concurrent hub value differs, LWW still
applies and one `hub:reconcile` event records the actual hub transition while
preserving the local events. Single-transition whole trails use a linear check;
ordered revisions use bounded backtracking over disjoint event paths, including
cyclic/coalesced edits. Timestamp ties imply no ordering. Stale/replayed
rows generate no hub events, though unseen originals can still replicate.
Invariant rejection rolls back both mutation and attached events. A proven
history mismatch still reconciles. If matching needs more than 10,000 generated
search states, the whole request rolls back and returns zero upserts, empty
`hub_at`, and one `history-ambiguity` rejection with `retryable: true` for every
submitted row, in order. Split revisions into smaller requests and retry; an
identical oversized request may reject again. No automatic split is added to sync.

History-bearing D1 batches that need failure isolation use rollback-only probes
before committing the accepted sequence once. Matcher or query exhaustion during
isolation cannot leave earlier siblings, original events, or helper tables behind.
Valid bulk requests still use one transaction.

Sync keeps ordinary history-table replication as a fallback for servers that
ignore the optional array. Rejections keep the push cursor in place and withhold
those mutations' attached events from the fallback. Deploy the transaction-time
arrival fix before clients perform checkpoint recovery. Deduplication is guaranteed for upgraded replicas
supplying original events; legacy compatibility is explicitly best effort.
An older or uninventoryed replica sends history separately, so a new Worker
cannot reliably recognize an original random-ID event before logging the direct
transition. Historical rows are never rewritten to guess away legacy duplicates.

The hosted Worker and self-hosted table-write/derivation service require
**Workers Paid** (D1's 1,000-query invocation limit); the Free 50-query ceiling
is not supported by these write budgets. Each batch statement counts as a query.
Push validation/isolation allows 750 statements, background derivation 200, and
direct/scheduled derivations share a 900-statement budget across all rows and
nested callers. Headroom covers route/auth work. A partial derivation returns
committed progress plus explicit `failed` entries for pending work; retry those
IDs or let the next sweep resume. SQL stays within 100KB and bulk row data uses
JSON parameters to remain below 100 binds per statement.

Normal 500-row pushes and 200-row provenance chunks with schema-derived options
and references use bulk reads/upserts and transaction-scoped triggers.
D1 statement/text budgets fail closed with per-row rejections; retry those rows
in smaller batches. No partial history remains after a failed transaction.

### Saved view query semantics

Version 1 saved definitions remain supported. Version 2 adds bounded filter
groups, relative dates and catalog option sorting. Flat filters and outer
groups combine with AND; each `{match: "all" | "any", filters}` group uses
AND or OR internally. Groups cannot nest. Queries permit at most 16 groups,
64 filters per group, 128 filters total and 16 ordered sort clauses.

`date_or_datetime` is a TEXT catalog property accepting either the existing
`date` format (`YYYY-MM-DD`) or the existing `datetime` format (UTC ISO-8601
with milliseconds). Values keep their precision; it never converts an all-day
date to midnight. Normalize offset-bearing source instants before writing and
retain any original source object separately. Existing `date` and `datetime`
properties keep their narrower validation. Nullability follows the property.

`{column, op: "lte", relative: "today"}` compares a date, datetime or date_or_datetime with
the current local day. Relative filters also support `eq`, `ne`, `lt`, `gt`
and `gte`, and cannot include `value`. The saved definition retains an optional `timeZone`
(omitted means the reading device's current zone) and optional `dayStartMinutes`
(integer 0 through 1439, omitted means midnight). The host resolves that policy and supplies runtime `calendar: {today, start, end}`.
`today` labels the civil date on which the current policy interval began;
the bounds are consecutive configured local boundaries expressed as exact UTC
millisecond timestamps, with an exclusive end. For a boundary in a daylight-saving
gap use the next valid local instant; for a repeated boundary use its first
occurrence. Resolve each boundary in the named timezone, never by subtracting a
fixed UTC offset. Date-only comparisons use `today`; timed comparisons use the
interval without changing source values. Refresh at the policy boundary and on
resume. Never persist this runtime clock.
Absent or invalid calendar context rejects execution instead of broadening it.

Sort `mode: "options"` uses catalog option order. Multi-selects use the
first stored selection; later selections do not break ties. Unknown values
remain visible after known options, then empty values, in either direction.
Remaining clauses apply in order, with a stable ID tie-breaker. Omitted mode
keeps ordinary value sorting. Older clients report version 2 unavailable.

Version 2 definitions may also store `actions: [{id, label, values}]` and an
ordered `layout: [{kind: "column" | "action", id}]`. Actions contain literal
property patches. They cannot change identity, clocks, deletion state or
read-only fields. Layout references must identify selected columns or existing
actions. Invalid definitions make that saved view unavailable.

Call core `runRowAction({viewId, actionId, rowId, expectedUpdatedAt})` with the
full selected row's revision. The mutation session resolves the current saved
action and row inside its writer transaction, then uses the ordinary validated
write, history and pending-sync path. A successful action supplies the same
undo receipt as an edit. A stale action or failed commit preserves the row and
previous undo receipt. This is a local commit; normal sync rejection handling
still applies. Definitions contain no executable expressions or workflow rules.

### Durable change subscriptions

`POST /v1/subscriptions` accepts `{label, start: "now", sources}`. Each
source names a table and a list of scalar TEXT, INTEGER or REAL columns.
Numeric changes preserve JSON numbers, including checkbox values `0` and `1`.
Add `lifecycle: true` to a source to record live row insertion, deletion and
restoration even when all watched values are null. Such events may have an
empty `changes` array; restoration uses operation `restore`. Without this
option, only watched value changes emit events and restoration retains the
legacy `update` operation. Timestamp-only edits and physical cleanup of an
already deleted row emit no event.

The optional session capability `subscription_features: "scalar-lifecycle-v1"`
advertises these semantics alongside the `durable-pull-v1` delivery protocol.
Poll `GET /v1/subscriptions/<id>/events?wait=30`, then acknowledge its durable
delivery with `POST /v1/subscriptions/<id>/ack` and `{delivery_id}` only after
retaining recoverable work. Consumers require `subscriptions:consume:<id>`
plus read grants for every source. A delivery repeats until acknowledged;
polling does not move the cursor. Capacity failures roll back the source
mutation. Source definitions are immutable; retire a subscription to replace
them. Existing subscriptions retain their exact stored trigger semantics.

### Files

`PUT /v1/files/<key>` stores a binary body with its `Content-Type`.
`GET` and `HEAD` on the same URL return the stored bytes or metadata (404
for an absent key). URL-encode each key segment; empty segments, dot
segments, encoded separators, control characters and percent signs in
stored keys are rejected. Uploading an existing key replaces its contents.

`DELETE /v1/files/<key>` permanently removes one object and returns
`{key,bytes,etag}` (404 for an absent key). Only `full` and `admin` tokens may
delete; file grants never do. Keys under `__r2_data_catalog/` (the events
table's Iceberg files) are refused with 403 unless the request carries
`?catalog=1`. Every delete posts a `file.deleted` entry (key, bytes, etag,
token name) to the notification feed. `soma files rm <key> --yes [--catalog]`
is the CLI form.

`POST /v1/files/rehome` with `{"from": <stored key>, "to": <new key>}` is an
admin-token repair for an object whose stored key the URL rules cannot address
(for example a literal `%`). It copies the object to `to`, which must be a valid
key that does not exist yet (412 otherwise), checks that size and etag match,
deletes `from`, returns `{from,to,bytes,etag}` and posts a `file.rehomed`
notification. A copy that does not match is removed and the original kept (502).

`GET /v1/files?prefix=<p>&cursor=<c>&limit=<n>` lists object metadata as
`{objects:[{key,size,uploaded,etag}],cursor}`; `cursor` is opaque and `null` on
the last page, `limit` is 1-1000 (default 100). A `files:read:<prefix>/` holder
may list only prefixes inside its grant; `full` and `admin` may list anything,
including the whole archive. `soma files list <prefix>` follows every page and
prints the objects as JSON.

Mint client tokens with literal, slash-terminated namespace scopes, for
example `files:read:photos/client/,files:write:photos/client/`. Read and
write grants are independent. A table scope grants no file access. The
legacy `/v1/archive/<key>` read route uses the same file read grants;
`full` and `admin` retain whole-archive access. Clients need only the hub
URL and their scoped bearer token, never storage-provider credentials.

### Synced sidebar table pins

`soma table provision sidebar-pins` installs the shared navigation table through
normal logged schema and catalog writes. Run `soma sync` to deliver it to enrolled
replicas. Repeating provisioning verifies the existing table without modifying it;
an unrelated same-name table is preserved and reported as a collision. No pin
choices are seeded. The UI stores pin order as ordinary rows with history and
soft deletion, so successfully synced pins recover on a fresh replica.
`soma table rename OLD NEW` retargets recognized pins and preserves their order.
Concurrent offline reorderings use the usual row-level last-write-wins behavior.
