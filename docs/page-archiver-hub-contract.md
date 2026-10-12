# Restricted consumers and durable subscriptions

This contract adds generic shared-service functionality. Selectors, capture-table
schemas and consumer credentials are operator state, never repository defaults.

Table grants are exact independent `tables:read:<table>` and
`tables:write:<table>` strings. Canonical body.table must be authorized before
querying its existence or schema. Only catalogued base tables are eligible.
Narrow tokens cannot read global catalog, schema, stats, cursor, history,
provenance, internal tables, arbitrary SQL/views, backups or streams. v1 denies
metadata rather than pretending to provide a safe partial replica. Row clients
use an explicit configured schema. Files remain independently prefix-authorized.

GET /v1/session retains name/scopes and adds capabilities: row_api `v1`, schema
`full-ddl-v1` or `none`, replica_sync boolean, files `opaque-key-v1`, and
subscriptions `durable-pull-v1`.
Only broad read access supports full schema; full/admin support replica writes.
Narrow schema/replica requests return status 403 with exactly:

```json
{"error":"scoped_replica_unsupported","message":"This credential supports direct API access only; replica synchronization requires broader table access."}
```

Clients require explicit replica_sync=true and schema=full-ddl-v1 when capabilities
are present. Only absent capabilities retain the legacy full-token default.
Existing rejection of admin credentials in consumer enrollment remains in effect.
When capabilities are present, row_api, files and subscriptions must also match
their supported v1 shapes (subscriptions may be null for pre-delivery hubs).
Malformed/unknown capability versions fail closed. Canonical fixtures and generated
TS/Swift types must agree.

Narrow writes reject history attachments, arbitrary triggers, generated expressions,
unsafe defaults, derivations and enforced SQL rules. Only exact trusted timestamp,
history and outbox machinery may run implicitly. Guard policy/schema/catalog reads
in the same transaction as mutation to prevent concurrent policy changes. Validate
catalog references server-side; errors contain no denied values or SQL. Mutations
must not gain cross-table effects through foreign keys or history triggers.
Tables with active purge markers are ineligible for narrow writes: the existing
broad recovery path performs post-commit effects. Narrow policy guards marker
absence transactionally and never executes that recovery path.

Admin creates subscriptions with {label,sources:[{table,columns}],start:"now"}.
IDs are opaque. Selectors are immutable. States active/paused/retired mean deliver
and record / record only / stop recording, respectively. No implicit discard.
Consumers need subscriptions:consume:<id> and read access to every selected source.
Unknown IDs and unauthorized callers receive identical denials.

Private _change_subscriptions and _change_events record exact old/new selected
values, source identity/revisions, stable event ID, UTC timestamp and per-subscription
monotonic decimal sequence atomically with the accepted mutation. Include insert,
update, accepted derivation, soft/hard delete; omit rejected/stale/noop/timestamp-only
changes. Capacity/event-size limits reject mutations transactionally rather than
silently discarding events. Pending events never expire or get pruned implicitly.

GET /v1/subscriptions/<id>/events?wait=30 holds at most 30 seconds, wakes when a
commit names a selected source table (rechecking at least every 25 seconds and at
the deadline), returns at most 100 events and 1 MiB. Persist delivery_id and through_seq
before offering a nonempty batch. Until ACK, return the identical batch. Empty
responses have null delivery_id, current acked_seq as through_seq, and events [].
Paused and drained retired subscriptions honor the same wait on empty responses.
GET never advances ACK. Recheck live token status and source grants immediately
before releasing private data, separately from memoized authenticate.

POST /v1/subscriptions/<id>/ack {delivery_id} advances only the recorded boundary.
The last accepted receipt is idempotent. Conflicting receipts return 409. Mini
consumers must durably commit the batch and pending receipt before ACK. State loss
after ACK requires explicit reconciliation. Delivery preserves URLs, not guaranteed
historical external-site content.

Subscriptions remain capped, including ACK/admin status. No new handler or cron.
Keep the usage wrapper, memoized authenticate(request,env,ctx), tenant.name,
SWEEP_CRON, nodejs_als, both CORS layers, Retry-After exposure and unauthenticated
OPTIONS. Narrow 429 bodies contain no usage totals. Clients retry after the smaller
of Retry-After and 3600 seconds. Existing usage.cap is the sole cap notification.

Files accept immutable conditional creation and return verifiable SHA-256, MIME
and bytes. ETags are not assumed to be checksums. HTML is attachment + nosniff +
sandbox/default-src 'none' CSP. Table access alone never grants file access.
Captures use opaque keys; successful and failed attempt metadata stay separate.
A shared captures table/prefix requires an explicit combined-source grant; future
restricted viewers need row and file source policy. PNG is the default preview;
HTML viewers remain a separate future feature.

Subscription capacity defaults to 100,000 pending events and 256 MiB of conservative
encoded-event accounting. Admin creation may set max_pending_events (1..1,000,000)
and max_pending_bytes (4096..1 GiB). A single event must leave 4096 bytes within the
1 MiB delivery envelope. No automatic expiry frees capacity. Activation accepts canonical timestamp and exact subscription triggers only.
The timestamp projection uses SQLite's statement-stable clock, so event revisions
agree with the committed row regardless of AFTER-trigger creation order. Physical
cleanup of an existing tombstone does not repeat its logical deletion.
Schema replay guards active/paused watched table definitions and their entire
trigger set, plus all internal outbox triggers, in its D1 transaction; structural changes require retiring affected subscriptions first.
Unrelated schema changes remain available. Subscription retirement does not discard
pending events.

Conditional file creation uses PUT with `If-None-Match: *`, `Content-Type` and
`X-Content-SHA256` (64 lowercase hex digits). R2 verifies the streamed checksum
before committing. 201 returns `{key,mime,bytes,sha256,etag}`; an existing key is
412 `{error:"file_exists"}` even for identical bytes. Reconcile independently
with HEAD and compare Content-Type, Content-Length and X-Content-SHA256 before
publishing metadata. A mismatch requires a new key, never overwrite. Legacy
unconditional writes remain supported; unchecked legacy objects return a null
JSON checksum and omit the checksum header. ETag is separate and opaque.
All object responses, including legacy reads, use attachment/nosniff/sandbox CSP
because a supplied MIME type cannot establish that content is passive.
