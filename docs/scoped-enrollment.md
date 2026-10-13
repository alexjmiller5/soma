# Scoped device enrollment

A consumer holds its own generated credential and a user-provided service URL.
The host owns URL validation, cryptography, browser launch, polling deadlines,
cancellation and secure storage. A profile credential holds exactly the
profile's grants. It never participates in replica synchronization or
governance proposal/approval. Which consumers use profiles, and how servers
enroll, is the standard in [consumer-access.md](consumer-access.md).

## Service configuration

`ENROLLMENT_PROFILES` is optional, service-owned JSON keyed by a public profile
ID. Each value has `label`, `scopes` and optional `config`. IDs match
`[a-z][a-z0-9-]{0,63}`. Labels follow the existing enrollment label policy.
A profile has 1-256 distinct grants. `tests/fixtures/enrollment-scopes.json`
is the grammar contract, checked by core, the Worker and the Python CLI:

- Column grants `tables:read:<table>:<column>`, `tables:patch:<table>:<column>`
  and `catalog:read:<table>:<column>`. Each table must include its `id` read.
  Metadata grants require a read grant for that same column. Patch grants
  require reads for the same column plus `updated_at` and `hub_at`. Identity,
  creation/update timestamps, hub revisions and deletion fields cannot be patched.
- Whole-table grants `tables:read:<table>` and `tables:write:<table>`.
- `provenance:create:<table>`, only beside `tables:write:<table>`: insert-only
  origin edges onto that table's rows (see Narrow writes and origin edges).
- Broad grants `tables:read`, `tables:write` and `streams:append`. Broad
  `tables:read` adds schema access (`schema: full-ddl-v1`), never replica sync.
- `streams:read:<name>`, `streams:append:<name>`, `captures:submit:<adapter>`
  and `captures:read:<adapter>`.
- `rows:create:<policy-id>:<revision>`. It must name a current
  `ROW_CREATION_POLICIES` revision, or the whole profile is unavailable.
- `files:read:<prefix>/` and `files:write:<prefix>/`: slash-terminated
  segments of `[A-Za-z0-9_][A-Za-z0-9._-]*`.
- `subscriptions:consume:<subscription-uuid>`.
- `backups:read` and `backups:write` ([backups.md](backups.md)), independent
  of every table grant.

Internal, catalog, history, provenance and purge tables are not eligible for
table grants.
Full, admin and token administration are never profile grants; a profile that
contains one is unavailable. Applications choose a public profile ID and exact
expected grants; customers enter only the service URL.

The value may be `gzip:<base64 of the gzip-compressed JSON>`: one Worker secret is
capped at 5.1 kB, and decompression is bounded like plain JSON (64 KiB).
Profile values are installation state, never personal schema in source.
Unknown, unavailable or invalid requested profiles fail closed. Omitting a
profile retains existing full-device enrollment for existing clients. A
profile-bound fingerprint cannot be reused through legacy approval or another
profile. Start with a new candidate to reenroll. Config edits apply to future
approvals, not stored credential grants. Revoke existing credentials explicitly.

## Canonical operations and receipt

- `enrollmentApproval({fingerprint,name,profile?})` returns the existing policy
  and `/login?key=<fingerprint>&name=<encoded label>&profile=<id>` when supplied.
  Only the SHA-256 fingerprint appears in the URL, never the candidate token.
- Browser GET displays the resolved profile label and exact scopes without
  creating auth state. The same-origin POST includes `key`, `name`, `profile`
  and `profileRevision`. A changed policy returns 409. Registration checks
  the stored binding, scopes and revocation in the committing batch.
- `GET /v1/session` adds optional `enrollmentProfile: {id,revision}`.
  `EnrollmentProfileReceipt.revision` is an opaque string, exactly 64 lowercase
  hexadecimal characters. It is SHA-256 of UTF-8 JSON.stringify of
  `[id, trimmedLabel, sortedScopes]`, not a timestamp or counter. Hosts retain
  the server receipt; they do not reconstruct it from display strings.
- `EnrollmentProfileExpectation` is `{id: string, scopes: string[]}`.
  `validateDeviceSession({data,expectedProfile?})` and
  `enrollmentPollResult({reply,expectedFingerprint,expectedProfile?})` are the
  generated operation argument forms. The direct functions take `(data,
  expectedProfile?)` and `(reply,expectedFingerprint,expectedProfile?)`.
  Profile validation requires the exact scope set, valid receipt, matching
  profile, `replica_sync: false`, schema `none` (or `full-ddl-v1` when the
  profile holds broad `tables:read`) and no governance authority. Polling also
  binds the exact candidate device fingerprint. Revalidate on reconnect.
- `POST /v1/session` revokes the authenticated credential and returns
  `{logged_out:true}`. A 401 is not proof of cancellation of an unapproved link.
  Existing generation fencing and late-approval cleanup remain required.

No new transport or credentials are supplied by these pure functions. Polling
remains every 5 seconds, 300 seconds maximum, with a 65536-byte response bound.
Neither receiving a token callback nor opening the browser proves approval.

## Minimal native binding

`soma-core/enrollment` exports only the pure enrollment policy functions. A
native host can bundle this entry for JavaScriptCore, with no SQL driver,
HTTP adapter, replica handlers or Iris dependency. Generated Swift DTOs
are in `core/generated/CoreContract.generated.swift`; this file is types and
codecs, not an alternate Swift validator. The test suite bundles the minimal
entry into a realm without URL, fetch, crypto, clocks or storage, and passes a
real Worker profile approval/session through it. The app owns its small JSC
invocation and lifecycle adapter; do not copy policy into a second validator.

## Projected reads

`POST /v1/rows/pull` uses existing `{table,columns,limit?,after?,where?,since?}`.
Projected credentials must explicitly list nonempty permitted columns. The
`id` grant is required because keyset cursors expose IDs. `where` can use only
permitted columns, with the existing scalar equality semantics. A nonempty
`since` (an inclusive `hub_at` arrival cursor) needs the `hub_at` grant; it then
also opens `POST /v1/cursor` for the table and batched pulls
(`{batch:[...]}`, up to 50 pulls and 5,000 rows), as used by the table-pull
helper in [consumer-access.md](consumer-access.md). Whole-table grants include
both. The page size is 1-200, default 100. Response remains `{rows,next_cursor}`.
Deleted rows are returned when selected; consumers handle tombstones.

Authorization precedes data lookups. Catalogued base-table checks and the
checked-read transaction still apply. Broad and exact-table callers retain
existing behavior. Column grants do not authorize schema, options, files,
subscriptions, writes or derived values in other columns. This is not a
create-only Tasks writer contract.

## Conditional field edits

`tables:patch:<table>:<column>` authorizes only `POST /v1/rows/patch` with
`{table,id,values,expected_revision:{updated_at,hub_at}}`. Every `values` key
needs its own patch and read grants. The complete supplied revision must match
an existing live row. The ordinary catalog validation, history, atomic write
and receipt `{id,revision:{updated_at,hub_at}}` are unchanged. Missing, deleted
or stale rows return 409; never retry them automatically. A lost response is
uncertain, not evidence of failure. Read the current row before another edit.

These grants never authorize push, insert, lifecycle edits, caller history,
schema, replica synchronization or governance. Catalog invariants remain
enforced. The checked patch path additionally admits a deletion guard,
`SELECT a.id FROM changed a WHERE a.deleted_at IS NOT NULL AND <term>` whose
single `EXISTS (...)` or parenthesized term ends the statement: its deletion
predicate cannot hold for a live-row patch, whatever the term reads. A term
followed by anything else, or a group that closes early, is still denied.
A table with hub derivations accepts a patch that writes neither a
derived column nor any of its declared inputs; no derivation runs for it.
Browser approval lists every grant and labels any profile holding a write,
patch, creation, file-write, stream-append or capture-submit grant as read and
write access.
Canonical enrollment validation requires `conditional_patch: revision-v1`
as well as the exact profile/scope receipt. Existing reader profiles and
accepted credentials keep their original grants until explicit reenrollment.

## Narrow writes and origin edges

A `tables:write:<table>` holder writes through `/v1/rows/insert` and
`/v1/rows/push` with the same validation as a full writer, once the table passes
the scoped eligibility checks (AGENTS.md, Hub service). An enforced invariant of
that table is eligible when it matches one of the anchored templates in
`worker/src/scopes.js`, or when its SQL reads only ordinary base tables, no view,
private state, `sqlite_*`/`pragma_*` object or `dbstat`, in any quoting, and
contains no `;` or comment. Cross-table rules evaluate on the hub without
granting the writer access to those rows. A single-quoted literal naming an
ineligible object is also refused because SQLite accepts it as a table name.
Eligible rules run unchanged inside the write transaction. A rule that
fails to compile fails the request closed (400, nothing written). Rejections
stay generic.

`/v1/rows/insert` never changes an existing row, so it also admits a table with
hub derivations when the request's `columns` list no derived column: the hub
derives the new rows in the background exactly as after a full writer's insert.
An insert whose `columns` omit `deleted_at` (a column without a default)
creates only live rows, so it admits the same deletion guards as a live-row
patch. Push admits neither.

`provenance:create:<table>` adds `POST /v1/rows/insert` with
`table: "provenance"`. Every row carries nonempty string `id`, `from_kind`,
`from_ref`, `to_kind`, `to_ref`, `rel` and `asserted_by`, optionally `field`,
`detail` and `updated_at`, and no other column. `to_kind` is a table the caller
holds both grants for, `rel` is `imported_from` or `evidence_of`, and `id` is
`<from_kind>:<from_ref>:<to_kind>:<to_ref>`. `to_ref` must be a live row of
`to_kind`, and `field`, when set, one of its columns. Any other row makes the
whole request 403. An existing id is reported in `existing` and never changed.
The provenance catalog (allowed `from_kind` values, required fields) and its
invariants still apply. Push, patch and reads of provenance stay denied.

## Profile configuration and projected metadata

Profiles may contain `config: {version:1,namespace,bindings}`. Namespace is a
lowercase dotted identifier; bindings is an installation-owned JSON object.
Canonical sorted object keys, a depth limit of 16 and 16 KiB UTF-8 limit apply.
This is consumer configuration, never storage URLs, credentials or provider IDs.
A configured profile hashes `[id,trimmedLabel,sortedScopes,canonicalConfig]`.
Profiles without config retain the original revision algorithm.

`GET /v1/consumer/config` returns `{profile:{id,revision},config}` only for the
credential's enrolled profile, with `Cache-Control: no-store`. It takes no
profile selector. A changed profile/config or grant set returns 409 and requires
reenrollment. Missing config returns 404; operator tokens are not consumer
sessions. `soma-core/consumer-config` exports canonical pure configuration checks.

`POST /v1/catalog/projection` takes `{table,columns}` (1-256 distinct columns).
Every column needs both `catalog:read` and `tables:read` grants, even for an
operator calling this narrow endpoint. The reply is `{table,properties,rules}`:
each property has column, type, description, required, readOnly, optional static
options and an optional `default`, the catalog's static default text (a `sql:`
default is omitted). `rules` lists the human `text` of the table's enforced
invariants, by rule id, never their SQL. Only option values, descriptions, sort
ranks and palette colors are exposed; dynamic SQL, reference targets, SQL
defaults and private metadata are never disclosed or run.
Read-only includes identity/revision fields, derived/immutable/dynamic-option
properties and columns without a patch grant. Uncataloged engine columns
(`id` text; `created_at`, `updated_at`, `hub_at`, `deleted_at` datetime) project
built-in read-only metadata; any other column still needs one catalog row.
Metadata does not authorize edits; normal checked writes remain the final authority.

## Bounded record queries

Session capability `row_query: bounded-v1` advertises `POST /v1/rows/query`.
Clients require that capability; absence never permits a full-catalog fallback.
`soma-core/query` validates and normalizes the bounded request policy without
transport or credentials. Canonical wire types are generated from core.json.

The request is `{table,columns,filter?,order?,limit?,cursor?}`. A filter is an
`and`/`or` object with nonempty child arrays, or `{column,op,value}`. Operators
are eq, in, gte, lte, contains and is_null. `is_null` takes a boolean; contains
matches a literal substring with SQLite's ASCII case folding (no SQL wildcard
syntax). IN accepts 1-200 scalar values. Groups are bounded at depth 4 and 64
leaves. Order has at most three distinct column/direction pairs, asc or desc;
identity is the final ascending tie-breaker unless explicitly ordered last.
Known values precede nulls in both directions. Pages contain 1-200 rows, default
50. Projected, predicate, sort and identity columns all require read permission.

The reply is `{rows,next_cursor}`. Opaque cursors bind the normalized request,
inspected table/catalog shape and enrolled profile revision. Changing any of
those returns 409. A schema change during a read fails without disclosing a
stale projection. Text primary-key identity and SQLite native collations are
preserved; null identities and unsafe numeric sort values fail explicitly.
Tombstones are returned unless the authorized filter excludes them.

Pages are independent reads, not a snapshot. Clients deduplicate identities,
restart after relevant changes and never infer complete coverage from a page.
Indexes are installation schema, provisioned through the normal logged schema
contract. For null-last ordering, use matching expression indexes where needed;
the synthetic scale test verifies the query plan against a 250,000-row catalog.

## Capture adapters

An optional `CAPTURE_ADAPTERS` service secret configures fixed HTTPS adapters.
Each entry has `url`, a dedicated `credential`, and `fields` mapping logical
edit names to arrays of required `tables:patch:TABLE:COLUMN` grants. Every
configured grant must be present before submit, because resolution can infer
edits from input text. No endpoint, workspace or credential comes from callers.
The adapter owner separately limits its gateway credential to categories and
logical fields; changing a name does not change a credential's authority.

The caller needs `captures:submit:ADAPTER` or `captures:read:ADAPTER`.
`GET /v1/session` advertises only configured, usable adapters in
`capabilities.captures = {protocol:"receipt-v1",adapters:[{id,read,submit}]}`.
Hosts use `soma-core/capture` to check capability and validate receipts.
Enrolled callers with changed profile bindings or grants receive 409 before
submission. Revoked tokens are denied by ordinary authentication.

`POST /v1/captures/ADAPTER` submits `{request_id,input,intent,fields?}`.
The request ID is a canonical lowercase UUID; input has exactly one `text` or
HTTP(S) `url`; intent is `save` or `record_consumption`. The same UUID must be
retained for retries. `GET /v1/captures/ADAPTER/REQUEST_ID` reads the same caller's
receipt. Request and response bodies are bounded to 64 KiB and redirects are
refused. Upstream submissions wait up to 60 seconds, because acceptance can queue
behind the adapter's serialized writer; receipt reads wait up to 15 seconds.
Device tokens never leave Soma.

A 202 `received` or `processing` receipt is acceptance only. A `saved` receipt
includes the resolved `{kind,id}` after verified commit. `needs_review`,
`failed` and `uncertain` never imply success. A transport failure has unknown
acceptance; query or resubmit the same UUID, never silently create a new one.
The adapter owns receipt persistence, deduplication and mutation reconciliation;
Soma adds no queue, receipt database or schedule.
