# soma-core

Shared TypeScript behavior for browser and JavaScriptCore clients. Runtime
source imports no platform modules. Inject a `SqlDriver` and a `Hub`.

- `sync(driver, hub, options)` replays schema, snapshots writes, pulls pages,
  pushes pending revisions and records rejected edits in `_core_rejected`.
  Cursors in `_core_sync` are per table and deliberately independent of the
  Python client's global checkpoints. The endpoint is bound before replay.
- `maxRows` defaults to 50,000 rows. Catalog tables always sync. Set
  `tables: { table_name: true }` to include a large table, or `false` to exclude
  one. Overrides change replication only; retained local rows are not deleted.
- `writeRow(driver, table, patch)` creates when `id` is omitted and edits when
  an existing `id` is supplied. Use `deleted_at: true` for trash and `null` for
  restore. Defaults, validation, timestamps and original cell history commit
  together. Pass `expectedUpdatedAt` in write options from the opened record
  to reject stale edits. Components must not write raw SQL. `isReadOnlyTable`
  recognizes built-in system tables and catalog entries with `kind: system`.
- `saveCatalogProperty` and `saveCatalogRule` are explicit metadata editors.
  They require the displayed `expectedUpdatedAt` (null for a new identity),
  an ordinary user table, complete catalog storage, supported trigger/FK
  topology and trusted metadata coverage on bound replicas. A property edit
  may explicitly add a nullable physical column using its canonical storage
  type; the DDL, metadata and `catalog_log` entry commit together. Existing
  record values are never rewritten or retroactively repaired. Options retain
  their descriptions. Enforced rule SQL must compile with portable
  before/changed/now contexts. Invalid prior metadata can be repaired without
  allowing ordinary record writes to bypass validation. Missing engine tables
  are not provisioned implicitly. Changes use normal schema/row sync and
  pending receipts; catalog changes do not create record Undo receipts.
  Hosts must reload catalog and editing availability after a successful edit
  and preserve any unrelated drafts. Adding a column invalidates old schema
  coverage until the normal sync completes.
- Each `createCoreHandlers` instance holds up to 100 volatile undo receipts for
  successful human record writes, row actions and saved-view changes. `undoStatus({})` returns `{ action: null }`
  or an action with `receiptId`, `table`, `rowId`, and `kind` (create, edit,
  trash, restore). `undo({ receiptId })` returns the row from a fresh validated
  inverse write: create becomes trash, edit restores changed fields, trash
  restores, and restore creates a fresh tombstone. Combined field/tombstone
  patches are inverted together. Old timestamps and history are never restored.
  Capture occurs inside the existing writer transaction; publication follows
  COMMIT. Undo requires the captured revision, table shape and stored values
  (ignoring `hub_at` bookkeeping), and rechecks every normal writer guard.
  Failure retains the receipt. Success exposes the previous action, with no redo.
  Only the newest handle is accepted. Earlier same-row receipts advance to the
  inverse revision only with an exact preimage match; external changes conflict.
  Timestamp-only writes preserve undo. Saved-view restoration revalidates its
  definition against the current catalog. Direct `writeRow` callers do not acquire a UI session.
  Closing/replacing a workspace must discard its handler instance; reopening
  starts empty even when history survives. No undo data is stored or synced.
  The session queues writes, undo, saved-view mutations and undoStatus through
  receipt publication; hosts still serialize other driver use and own locks.
  Each autosave is separate: label the action **Undo last saved change**. Hosts
  cancel debounce without flushing drafts, prevent saves during undo, and use
  the displayed receipt handle. Preserve newer drafts and pause their autosave
  until explicit review/save; otherwise they could immediately reapply the
  undone text. Refresh unchanged editor fields from the returned row. Text
  editor undo remains separate. Failure keeps both draft and core receipt.
- Each successful `writeRow` also commits a `_core_pending` marker for that
  table, row and revision. Repeated edits coalesce into one pending row.
  An accepted sync receipt clears only markers at or below its submitted
  revision; newer concurrent edits, rejections and lost receipts stay pending.
- `syncStatus(driver)` returns `{ lastSuccessfulSync, pendingUiEdits, rejected, skippedTables }`
  from local durable state. The timestamp is the last completed core round's
  checkpoint, or `null`; rejected rows do not hold it back. Counts are pending UI-written rows and rows in the
  rejection inbox. Pending UI edits await this core's own valid receipt even
  if Python has already pushed them; this is not the entire CLI sync queue.
  `skippedTables` records the last completed pull round's exclusions in the
  existing `_core_state.skipped_tables` JSON key, in the final ready transaction.
  Rejected pushes still publish the completed pulls' exclusions and the
  completion time. HTTP or transaction failure preserves both previous values. Missing history yields `[]`; malformed
  stored lists fail explicitly. Hosts read this list after reopen rather than
  writing their own copy. It is a warning about that round, not coverage or
  freshness proof, and an empty list does not certify a complete replica.
- `readRejections(driver, { limit?, offset? })`, or the generated `rejections`
  operation, reads the durable inbox without initialization, DDL or mutation.
  It returns `{ rejections: [{ table, rowID, submitted, errors }], nextOffset }`.
  The default limit is 100, maximum 200, and default offset is zero. One extra
  row detects the end exactly, including a full final page; `nextOffset` is
  then `null`. Pages use binary table/row-ID ordering. Restart from zero after
  sync changes the inbox; separate pages do not share a snapshot.
  IDs are nonempty strings preserved exactly, including Unicode and whitespace.
  `submitted` is the saved push snapshot. `errors` preserves the hub's complete
  rejection objects and unknown JSON fields, without classifying or flattening
  them. Each error and the snapshot must identify that same exact row ID.
  Missing storage returns an empty page. Malformed stored data, including a
  malformed lookahead entry, throws a payload-free error for the whole page;
  nothing is skipped, erased or repaired. Hosts show that error and keep the
  retry offset. Do not log or include submitted values in telemetry.
  Repair requires a fresh full local row and its `updated_at`, using the normal
  validated writer. Retain newer drafts and review rejected values explicitly;
  this snapshot is not a replacement row. Saving a correction does not clear
  the inbox; an accepted sync receipt does. Refresh after failed sync as well,
  because earlier receipts in that round may already have committed.
- `validateBackup`, `previewRestore`, `exportReplica` and `restoreReplica`
  read and write SQL dumps through an injected `BackupFiles` adapter (the
  fifth `createCoreHandlers` argument): hosts own files, gzip and progress.
  `restoreReplica` writes a recovery dump first, replaces the replica in one
  transaction, resets device sync state and clears the undo stack.
  `hubBackups`/`createHubBackup` read and take hub backups. See
  `docs/backups.md`.
- `readCatalog(driver, tables?)` decodes properties; `tables` limits the read to
  those tables' entries, properties and rules (row reads, saved views and view
  defaults pass only the tables they touch; the whole catalog is about a
  megabyte on a large estate). `catalogRevision` returns a short value that
  changes whenever any catalog row is added, edited, retired, pulled or removed;
  hosts compare it before re-reading the whole catalog. `compileView` produces parameterized,
  catalog-scoped SQL with filtering, sorting and bounded pages. `contains`
  remains a literal substring filter (or exact JSON array membership).
- `listViews(driver, { table, trash? })` reads shared saved definitions and
  returns `{ views, unavailable }`. Each record carries `id`, `name`, `tbl`,
  `updated_at`, `deleted_at`, `definition`, `view` and `unavailable`. Malformed
  definitions, unknown versions, missing tables and removed columns disable
  that record without failing the whole list or modifying stored data.
- `runRowAction({ viewId, actionId, rowId, expectedUpdatedAt, expectedViewUpdatedAt })`
  runs a saved literal patch through the ordinary writer. Hosts pass the row
  revision and the saved-view revision whose action they displayed. Both are
  checked under the same writer transaction; a changed definition requires a
  reload before execution. Failed actions preserve row history and prior undo.
- `saveView(driver, { table, name, definition, id?, expectedUpdatedAt? })`
  creates or edits through `writeRow`; an existing ID requires its selected
  revision. `deleteView(driver, { id, expectedUpdatedAt })` tombstones without
  requiring a readable definition. Both retain normal write restrictions,
  validation, history, pending markers and stale-edit rollback. Deletes still
  require matching storage and a valid revision. Missing/colliding storage is
  a setup error; core never provisions, adopts or repairs it automatically.
- Saved definitions are `{ version: 1, columns?, filters?, sort?, search?,
  trash?, widths? }`. Columns must be distinct; widths map known columns to
  positive finite numbers. Version 2 adds groups, timezone, day boundary, row
  actions, layout, presentation and `wrap` (distinct known columns whose cells
  wrap; absent means none wrap). Filters/sorting/search use the existing core view
  compiler. No table name, pagination, default selection or private device
  preferences are stored in the JSON. The default remains a transient
  All records view using catalog columns.
- **`definition.columns` becomes SQL projection in the returned `view`.** It
  can omit `id`, `updated_at` and hidden fields. For visual layout only, omit
  `columns` when calling `rows`; otherwise fetch a full row by ID before
  editing. Never populate a full-record editor from a partial grid row.
- `search(driver, { text, table?, limit?, offset? })` searches the local replica
  with FTS5 and returns `{ table, id, label, excerpt }[]`. `View.search` uses
  the same index before filtering, sorting and paging. Search ANDs literal
  word prefixes, folds case/accents with `unicode61`, and does not accept FTS
  operators. It is word search, not arbitrary substring matching. Empty or
  punctuation-only global searches return no hits. Limits default to 50 and
  cap at 200; queries are limited to 4096 characters / 64 words. Global hits
  rank by BM25 with table/id tie-breakers and exclude trash; row views retain
  their explicit sorting and trash selection. Ranking reads every match, so it
  covers the `SEARCH_RANKED_MATCHES` (2,000) most recently indexed live matches
  in scope: a one-letter prefix over a large estate stays a fraction of a
  second, and fewer matches rank exactly as before.
- Search indexes physically present, cataloged textual columns, including raw
  Markdown, select, URL, email, phone, ref, date, datetime and date_or_datetime values. It does
  not search uncataloged fields, JSON, numbers, blobs, or remote skipped data.
  Retained rows from skipped tables are still local results and may be stale:
  hosts must keep sync coverage warnings visible. No result is a claim of
  complete hub coverage. Labels use the shared display-name function.
- Excerpts are computed for the returned page only, from the stored index text:
  up to 24 words around the first word starting with a search term (accents
  folded), capped at 512 characters, with
  conservative cleanup of Markdown headings, lists, links and inline markers.
  Link destinations, code and table text remain searchable. This is **raw
  Markdown indexing plus display cleanup**, not a maintained plain-text
  projection or a Markdown renderer. Render excerpts as plain text, never HTML.
- `createHttpHub(endpoint, token, fetch)` is the browser transport. The native
  host supplies a `Hub` using URLSession. Neither credentials nor SQL drivers
  are owned by the core. HTTP adapters must expose the server Date header and
  impose a request timeout. Clock skew above five minutes blocks pushes.
  An optional `Hub.progress(SyncProgress)` is told as a round advances:
  tables done of the round's tables, rows received of the rows its full pulls
  expect (from the hub's cached counts; null for a changes-only round) and the
  table being pulled. Hosts derive status and estimates from it.
- `ServiceHub` extends `Hub` with `get(route)`. `createHttpHub` implements both;
  native hosts provide the same HTTPS/loopback, no-redirect, no-cookie behavior.
  `readUsage` returns the deployment's `UsageSummary`, preserving unmeasured
  values as `null`. `readNotifications` walks the complete ascending feed from
  zero each time to reconcile shared read state. Invalid pagination, failed
  requests and the 1,000-page bound throw without returning a partial feed.
  `markNotificationsRead(hub, { ids?, through? })` marks explicit IDs and/or
  all sequences up to and including `through`, returning `{ unread_count }`.
- `notificationPresentation(feed, previousBaseline)` returns
  `{ notifications, baseline }`. A `null` baseline suppresses history and uses
  `latest_cursor`; later calls select unread notifications above the baseline,
  deduplicate by stable ID, and advance only through collected sequences.
  Hosts own permissions, timers and persistence per canonical endpoint, and
  save the proposed baseline only after successful presentation. Unknown
  notification producers/types and their JSON data remain supported.

`SqlDriver.transaction` must serialize other callers through commit/rollback.
The browser host must exclude overlapping rounds across tabs with a Web Lock.

`planSelectedInverse({ target, eventIds }, evidence)` is a pure governance
planning primitive. A trusted service loader must supply complete, canonical
commit-ordered events through the current row revision and exact typed current
cells. Pagination, timestamps, and matching values are not completeness proof.
The planner preserves unrelated fields, rejects later unselected same-column
events (including value cycles), and returns no partial differences on conflict.
Legacy unknown values stay unavailable; integer strings preserve SQLite int64
precision. A selected cycle can produce no differences and must not manufacture
a timestamp-only write.

This function does not load/authenticate history, validate catalog dependencies,
issue a preview token, or write a row. It is not a CoreOperations RPC accepting
client-asserted evidence. The service must acquire and guard evidence again in
its atomic approval transaction. The configured Worker supplies that service;
`docs/governance-api-contract.md` and `docs/governance-transport-contract.md`
define its boundary. `createGovernanceAPI(capability, transport)` returns null
without a supported credential capability and raw transport. Pass the resulting
adapter as the fourth `createCoreHandlers` argument; omission keeps all nine
operations unavailable. `createHttpHub().governancePost` preserves real HTTP
status/body pairs, including errors, for canonical validation. Hosts own current
session binding, transport cancellation and durable pending-request journals;
regenerating types does not activate those integrations.
Mutation errors require `resolution: unresolved | not_committed`. A typed denial
of a retry does not resolve the original request; only a durable authoritative
negative receipt can supply `not_committed`. Clients keep the exact journaled
request for unresolved and transport outcomes.
A native host sharing a Python replica must hold `<database>.sync.lock` around
sync. The core additionally refuses overlap on one driver instance.

SQLite must support **FTS5 with the unicode61 tokenizer**. Hosts may call
`assertSearchSupport(driver)` at database open for an explicit capability error;
search also checks on use and never silently falls back to a table scan. The
probe creates only local cache tables. Browser hosts need an FTS5-enabled WASM
artifact and must verify FTS reads through their read-only SQL adapter. Native
hosts verify the actual GRDB/JSC connection, not a separate CLI SQLite binary.

The search cache uses `_core_search_fts`, `_core_search_docs`,
`_core_search_dirty`, `_core_search_state`, `_core_search_mentions` and
`_core_search_work`. Queue-only persistent triggers record OLD/NEW IDs in the
same transaction as writes, including pulls and independent Python writes. They
invoke no FTS functions in those writers.

Only `searchIndexStep({budgetMs})` builds the index. Hosts call it after each
sync round, after local writes and while idle, until it returns `done`; each
call is one BEGIN IMMEDIATE transaction that works in chunks until the budget
(default 50 ms, at least one chunk) passes, so requests between calls never
wait long. It reconciles first when the catalog, schema or settings moved
(a stamp built and compared in SQLite, so no host's row-object key order
matters): in a few statements for the whole catalog (each crosses a host
bridge) plus any triggers it drops, it records per-table work in
`_core_search_work` without touching rows. Then it purges entries of retired or
changed tables (500 per chunk), indexes queued IDs, and backfills newly indexed
tables by walking their primary key from a saved cursor; a walk installs its
table's queue triggers as it starts (the walk itself reads every earlier change)
and records that schema change as reconciled. Index chunks hold at most 200 rows
and about 256 KB of text, and shrink after one overruns its time target. Labels
and FTS bodies are built in SQL from the source rows; only Markdown containing
`iris://table/` links reaches JavaScript, for mentions. It returns `{indexing, pending, done}`: `indexing` while rows
wait to be indexed, `pending` about how many (estimates stored per table, so a
step never counts one), `done` when no work, including purges, is left. `search`, `mentionedBy` (which reports `indexing`), `viewEmbed`,
`referencedBy` and searched `readRows` never build the index; they read what
exists, and a replica the step has not reached answers from an empty index.
The one exception keeps local edits visible whatever order a host runs things
in: once the index is otherwise current (reconciled, nothing owed), a read
indexes a queue of at most one batch itself; a larger queue (a pulled page)
waits for the step. A retired table stops answering at once, before its
entries are purged.

Provenance and every table over the sync size rule (`SIZE_RULE_ROWS`, judged
by sync's stored hub counts; without one, a rowid span within the limit settles
it and anything else is counted, stopping just past the limit) stay out of the
index. The `_core_state` key `search_tables` (`SEARCH_TABLES_KEY`)
holds a JSON object of table to `true` (index it anyway) or `false` (leave it
out); an unreadable value counts as absent. Sizes are judged when
reconciliation runs, which hub count refreshes and setting edits trigger.

Each chunk is a keyset range of the queue or table and looks up index entries
by identity (`CROSS JOIN` keeps the batch outermost; a plain join lets SQLite
range over all of the table's entries per batch), so its cost does not grow
with the table. `test/search.test.ts` asserts these query plans. Queued IDs and
actual returned IDs are both replaced in the binary-keyed cache, so source
collations such as NOCASE cannot collide across batches. A failed step rolls
back and retains its queue and cursors; missing cache components drop and
rebuild the whole cache, and missing triggers re-backfill their table. None of
this local DDL is logged or synced, and cache work does not create history,
pending UI edits or revisions on source rows. A dirty table with UNIQUE
constraints or custom collation also gets an indexed ID anti-join to remove
silent `INSERT/UPDATE OR REPLACE` victims when SQLite delete triggers are
disabled. Use `readRows` for searched views; callers using `compileView`
directly call `openSearchIndex` inside the same driver transaction first.

`writeRow` supports deterministic, table-scoped enforced SQL invariants after
verified replication coverage. `before` contains the selected row before an
edit (empty for inserts); `changed` is its actual SQLite snapshot/`EXCEPT`
difference, and `now.ts` is captured once. Both row contexts have the table's
exact shape, with no bookkeeping columns. Checks run before history/pending
edits commit, including for tombstones. Only the affected table's rules run,
matching Python's single-row write and Worker OLD/NEW contexts. This does not
make multi-row Python mutations or cross-table cascades replayable as one
atomic sync operation. `tests/fixtures/table-invariants.json` exercises Python
and core origins through their real hub implementations and second replicas.

Rules must be deterministic over their declared data and captured `now.ts`.
The shared core/Worker SQL text screen and Python parity fixture reject the
date/time function family (including safe explicit-input calls), CURRENT_DATE,
CURRENT_TIME, CURRENT_TIMESTAMP, randomness and connection-state functions.
Compare or slice `now.ts` directly, for example `substr((SELECT ts FROM now),1,10)`.
This conservative screen can reject matching text in comments/literals; it is
not a SQL parser or proof about indirect reads through views, custom functions
or data-dependent SQL. Those dependencies remain the rule author's contract.
Catalog defaults are separate and retain their existing behavior.

The durable `_core_coverage` certificates belong to sync, not UI preferences.
They certify an unfiltered full pull and subsequent successful incremental
walks for one endpoint, public schema/log identity, checkpoint and version.
Ordinary cursors, row counts and Python daemon acknowledgements never grant
proof. A table's pull continues from its cursor while its proof matches the
endpoint, checkpoint and that table's own definition; a schema change in
another table keeps it. Replay revokes the proof of every table an entry
creates, drops, renames or alters, so only that table backfills in full.
Skipped tables invalidate their proof before transport yields. Unchanged incremental refreshes retain
prior certified trust across interruption and restart. Applicable schema or
catalog changes revoke metadata trust before application; partial metadata
blocks bound-replica writes even when no invariant is yet present. Recovery
restores trust only after complete certification. Each table's cursors and
proof commit as soon as its pull and push finish; readiness, skipped tables
and the completion time commit after the last table. `_core_pull_progress`
keeps an unfinished table's first-attempt `since`/mark and last applied page,
so the next round resumes there (a deferral or replay discards it). A failed
request or host deadline never repeats finished work. None of this local
metadata is logged or synced.

A table's pull cursor is the round's `max_hub_at` (read before any pull), and a
table whose own newest arrival is older than its cursor is not asked at all; one
whose newest arrival is its cursor is asked only when the hub's `at_mark` count
for that stamp differs from what the replica pulled (`_core_pull_marks`), so a
quiet round is one request: `/v1/cursor`. Its `schema` id and the local log id
decide whether `schema/pull` runs (`_core_state.schema_exchange`), and the
`/v1/stats` counts behind the size rule are kept for a day or until a table
they never saw appears (`_core_state.hub_stats`). When the cursor reply carries `pull_batch`,
each pull request carries the current table's page plus the first pages of the
following tables (within its item and row limits; full pulls size pages from
`/v1/stats` counts). Pages fetched ahead are applied only when their table's
turn comes, through the same deferral and progress path; a hub over its byte
budget answers a prefix of the pages asked, and the rest are asked again.

Sync freezes candidate payloads and their original history in the main-database
`_core_sync_snapshot` within one transaction, then reads 200 candidates per
push batch. Rows the hub rejects as `write-budget` or `retryable` are pushed
again in halved batches within the round; only a row that still fails alone
enters the inbox. The private snapshot is cleared at startup and on exit; it never
resumes an abandoned round or changes logged schema. Pending UI payloads are
protected from incoming LWW replacement until their own receipt. Deferred
tables retain their old pull checkpoint/proof for replay. Superseded rejection
receipts retain a durable history hold without marking the newer edit rejected.

Invariant-checked writes require coverage of the target, validation catalogs,
declared reference tables and all compiler-reported rule/options/default reads.
History/provenance need proof when validation reads them, not just because the
writer appends history. Standalone unbound tables without enforced invariants
keep their existing behavior; references alone do not activate this coverage gate.
Adapters without `readDependencies` conservatively require coverage of
**every table in the global schema, including history/provenance**.
Unbound or externally imported files are not assumed complete. Coverage is
not freshness, a simultaneous remote snapshot, or a guarantee of hub acceptance.
The hub rechecks its own state; rejection retains the local pending edit and
history. There are no scoped replication assumptions or new hub endpoints.

`writeability(db, { table })` returns `{ writable, reason: WriteViolation | null }`.
It is an advisory over the same table guards as `writeRow`, with no persistent
changes; a successful
answer does not approve a patch or selected revision. The writer rechecks
inside its transaction. Reasons include `coverage`, `trigger`, `foreign_key`,
`invariant`, `context`, `schema` and `read_only`; UI can display `reason.message` directly.

### Compiler read metadata

The optional `SqlDriver` method is a trusted host seam, not a client RPC:

```ts
readDependencies?(
  statements: readonly SqlReadStatement[], // { sql: string; params?: Value[] }
  context: SqlReadContext,                // { ownedTempTables: readonly string[] }
): Promise<{ tables: string[] } | null>;
```

Prepare each input as a fresh single read-only statement on the transaction's
actual connection, without stepping it. Return a conservative union of ordinary
`main` table names, using canonical schema spelling and expanding SQL views to
their underlying reads. Use SQLite compiler read metadata, never SQL text parsing
or a persistent dependency cache. `null` means the complete set cannot be
established and blocks the write even if global coverage exists. Preparation
errors and malformed results also block; they never mean an empty read set.
An absent method retains the global gate. Only a verified empty read set returns
`{ tables: [] }`; core still requires target/catalog/reference proofs.

Core calls this method only for invariant-checked tables, within their existing
transaction. The batch contains every applicable invariant's actual runtime SQL
wrapper plus all SQL defaults/options for that table, even when an individual
patch might not use one. Invariant parameters are inspection placeholders; they
must not be evaluated. The same wrapper builds the executed `changed`/`before`
SQLite snapshot/EXCEPT contexts and captured `now.ts`.

Core first rejects any pre-existing TEMP object named `_core_write_before`, then
creates its own empty schema-shaped `temp._core_write_before`. Only after CREATE
succeeds does it pass `ownedTempTables: ['_core_write_before']`. The supplied list
is a trusted ownership assertion, never permission inferred from a SQL name.
The adapter verifies that the claimed TEMP tables exist as ordinary tables and
that there are no unrelated TEMP objects or conflicting main names. Core drops
only its owned snapshot in a finally block. Transaction rollback also removes
it on failure. The actual mutation later takes its separate selected-row snapshot;
advisory preparation never copies or changes user rows. Neither snapshot is logged
or persisted. Physical TEMP tables named `changed`, `before` or `now` are not
engine contexts and must not be trusted.

For wa-sqlite, collect `SQLITE_READ` inside the existing authorizer without
weakening its read-only policy. Count/EXISTS reads can have an empty database
qualifier: resolve them only against a verified unambiguous schema inventory.
For GRDB, retain its authorizer and use `Statement.databaseRegion` plus public
region membership/union/equality APIs. GRDB drops database qualifiers; reject
attached schemas and unowned TEMP objects before narrowing. Account for every
region element, not just matches found while enumerating known tables. Never
parse `DatabaseRegion.description` or inspect its private dictionary.

Known engine CTE pseudo-reads (`changed`, `before`, `now`) and built-in
`json_each`/`json_tree` iterators can be nonpersistent. Their underlying ordinary
table reads still count. A real main table with one of those names must not be
exempted. Unexplained CTE reads, virtual/shadow table dependencies, introspection
table functions, engine bookkeeping reads and ambiguous namespaces return null.
Reject unsupported dependencies, not merely the existence of unrelated virtual
tables such as the local FTS cache. A host with custom functions/modules that
perform opaque database reads cannot certify this capability until those reads
are accounted for; extension loading stays prohibited.

Core enforces `READ_DEPENDENCY_LIMITS`: 128 statements, 524,288 UTF-16 code units
of total SQL (`String.length`, Swift `utf16.count`), and 4,096 returned tables.
Hosts may rely on those trusted-caller limits. Discovery must prepare SQL and
read schema metadata only, never scan user rows. Dependency sets are recomputed
inside each advisory/write transaction. Durable proof, endpoint, schema and
refresh invalidations remain owned by `_core_coverage` and sync.

`tests/fixtures/read-dependencies.json` is the shared host conformance fixture:
fresh synthetic setup per case, then case setup, statements and ownership context.
Compare sorted table sets, null for unsupported inputs, or a thrown error for
invalid/non-read-only inputs. Its expression-error case must succeed at inspection
without executing the expression. Core tests inject the host metadata seam while
preparing real SQL; Python checks supported fixture sets with SQLite's authorizer.
Browser and native tests must run the fixture on their actual shipped adapters.
Bun's SQLite adapter lacks a public compiler-read hook and exercises the legacy
global fallback; no private Bun API or second vendored WASM is required.

Custom triggers and enforced estate rules remain blocked. Only the CLI's exact
timestamp triggers and core queue-only search triggers are supported. Every
declared SQLite foreign key anywhere in main/temp blocks writes, including
NO ACTION/RESTRICT: host enforcement differs, and cascade effects are not
journaled. Catalog `ref`/`multi_ref` validation continues normally. Adapters
must permit read-only
`PRAGMA main.foreign_key_list(...)` and `PRAGMA temp.foreign_key_list(...)`;
failure to inspect blocks the write. `INSERT/UPDATE OR ABORT` prevent implicit
REPLACE deletions, so the guarded writer changes one primary-key identity.

Guard work reads schema/catalog/certificate metadata and one FK list per
physical table. The before snapshot holds at most one row, and each invariant
returns at most one violation. Rule SQL can still scan large tables or joins;
this does not impose a CPU deadline or bounded SQL execution cost. No host
timer, progress-handler API, or whole-table JS snapshot is introduced.
Missing local references require their table to be included and synced.
Skipped tables can be browsed online through the read-only operations below.
Sync snapshots pending rows
in memory; very large full replicas will need snapshots staged in temporary
tables. Enrollment remains a host integration.

### Online read-only rows

`readRemoteRows(db, hub, { table, limit?, cursor? })` reads one page from the
existing `/v1/rows/pull` route. Limit defaults to 50 and must be 1-200. It
returns `{ rows: RemoteRecord[], nextCursor: string | null }`; each record is
`{ record, label, deleted }`, with all locally known physical columns, the
ordinary core display label and an explicit tombstone flag. Pass `nextCursor`
unchanged to continue, or omit it to refresh. A full final page still has a
cursor and requires one empty terminal request. Never infer a total count.

`readRemoteRow(db, hub, { table, id })` makes one equality-filtered pull with
limit 2 and returns `{ row: RemoteRecord | null }`. It rejects ambiguous or
mismatched results. Equality uses the ID column's SQLite collation: NOCASE and
RTRIM lookups return the stored ID spelling. The generated bridge operations
are `remoteRows` and `remoteRow`; their args also carry `endpoint`, and hosts
inject its transport/credential through `createCoreHandlers` as usual.

These are transient, read-only results, separate from local views, FTS and
editing. There is no persistent merge, DDL, sync checkpoint, coverage proof,
pending marker or rejected-history change. A successful read does not grant
writeability. Do not pass a remote record to the local writer. Neither method
initializes an external file or changes its endpoint binding.

At least one durable Python/core binding must already match the transport's
canonical endpoint, and every present binding must agree, before any HTTP.
The table must exist in the local main schema and active catalog, with a
single TEXT primary key named `id` and the `updated_at`/`deleted_at` columns.
Internal tables, views and virtual tables are unavailable. Shape checks use
`main.table_xinfo`, already part of the host read-only contract. Short metadata
transactions end before HTTP; the same binding, target shape, display metadata
and logged schema identity are checked again before returning a response.
Missing columns on the hub require ordinary schema sync, never a partial-row
fallback. The existing route's legacy `updated_at` fallback still applies on
tables without `hub_at`; malformed legacy rows with null revisions cannot be
promised visible by that route.

Cursors are versioned opaque strings scoped to endpoint, table and local
schema identity. They are not credentials, signatures or remote snapshots;
keep them with the current in-memory page, never use them as sync checkpoints.
Responses require exact requested columns, scalar values, valid revision and
tombstone timestamps, bounded row counts and a consistent terminal cursor.
SQLite compound SELECTs compare the returned IDs under the target column's
collation, including equivalent duplicates and progress past the previous ID.
Their source-table branch is `WHERE 0`: only metadata and the bounded response
participate, with no local row scan, staging or new adapter method. See
[SQLite compound SELECT comparison rules](https://www.sqlite.org/lang_select.html#compound_select_statements).

This is a live view with ID-ascending paging only. No remote text search,
arbitrary filters, custom sort, total count or simultaneous snapshot is
provided. Keep tombstones identifiable: the route does not accept a null
equality filter for active-only rows. Across a changing hub, clients must
deduplicate repeated IDs before keyed rendering, replacing an earlier
displayed row with the later response. That does not recover rows inserted
before an earlier cursor or establish completeness; Refresh starts over.
Hosts also discard late responses from a superseded workspace/request.

One operation makes one request. HTTP failures and the usage cap's 429 return
sanitized errors without retry or an alternate endpoint. The existing usage
service can explain a cap while local browsing remains available. The cap
still covers ID lookups and small pages. Transient pages must never be labeled
as replicated rows or counted as the local CLI queue.

Shared saved-view storage is an ordinary synced `views` table, with
`name:text!`, `tbl:ref!` (to `catalog_tables`) and `definition:json!`, plus the
standard ID/timestamp/tombstone/hub columns and canonical timestamp trigger.
The catalog table entry has `kind=table`, `display=name`. Property
`views.definition` carries `source=life-core`, `source_ref=saved-views/v1`:
this marker identifies the schema, never actual view definitions. All
definitions live exclusively in `views` rows. Names need not be unique.

An operator uses an existing replica and the supported logged-DDL workflow.
First sync with full schema scope and inspect the physical `sqlite_master`
entry through `soma sql`, plus `soma doc views` if the name already exists. Stop on a collision or any failed
step; an existing unrelated `views` table must never be silently adopted,
dropped or renamed. For absent storage only:

```sh
soma sync
soma table create views 'name:text!' 'tbl:ref!' 'definition:json!'
soma property set views.tbl --ref-table catalog_tables
soma table set views --kind table --display name --purpose 'Shared named table views'
soma property set views.definition --source life-core --source-ref saved-views/v1
soma doc views
soma sync
```

Set the marker last, after reviewing the schema and property metadata.
Ordinary clients receive this existing logged DDL and catalog through sync;
they need no schema provisioning rights. Include `tables: { views: true }`
when enabling saved views so the size threshold does not hide definitions.
This does not imply that every referenced target table is fully replicated.
`soma table rename` updates `views.tbl` only for the exact recognized schema
and marker, with ordinary validation/history in the rename transaction.
Column renames/removals leave affected definitions unavailable for explicit
repair; unknown JSON versions are never rewritten.

`schema/saved-views.json` is the canonical storage manifest: ordered `ddl`, one
`table` catalog seed, and `properties` catalog seeds. Core recognition reads
the DDL and identity metadata from this file; property `sort` values are seed
defaults, not recognition requirements. Python parity tests compare the same
manifest with the operator CLI's DDL and catalog output.

Consumers can import `soma-core/schema/saved-views.json` or vendor that exact
file alongside the core bundle. Keep the vendored JSON and runtime from the
same source revision and hash the JSON separately from the unchanged bridge
contract. The source package includes `schema/`; browser/JavaScriptCore bundles
inline the JSON and need no filesystem loader. There is no separate core
`dist` build. Consumers compiling an unbundled distribution must also ship the
JSON at the relative path expected by the emitted import.

Treat the manifest as immutable. Only an explicitly app-owned local/demo
initializer may use it to create absent storage; check for partial/foreign
schema and catalog collisions before any creation, and never adopt or repair
them automatically. Ordinary synced replicas still receive existing logged
DDL only. Core exports no provisioning operation, and the manifest contains
no actual view definitions or default selection.

Per-table preferred views use the optional ordinary synced `view_defaults` table.
`schema/view-defaults.json` defines its exact operator-provisioned schema and
catalog marker (`view_defaults.view_id`, `soma-core`, `view-defaults/v1`).
`getViewDefault({table})` is read-only. `setViewDefault` accepts a saved-view ID
(or null to clear) plus the displayed `expectedUpdatedAt` revision (null for
first creation), validates a live same-table view, and writes through the
ordinary history, invariant, outbox and Undo path. IDs are deterministic:
`default:v1:` followed by the table name's lowercase ASCII hex. Preferences
therefore sync without client-generated competing identities. Table renames
rekey recognized preference rows with a synced tombstone and monotonic revision;
invalid storage is never adopted. Rename invariant failure rolls back the whole
rename. Invalid, deleted or wrong-table targets return a visible fallback reason
without modifying either the preference or any saved view. Hosts apply this
preference only for plain table navigation; an explicit view/record destination
wins. Absent configuration uses the catalog-generated view. Operators include
both preference and saved-view tables in the client's permitted sync scope.

Related-record preferences use the same revision-checked operations and writer,
with `getRelatedViewDefault`/`setRelatedViewDefault` and the separately provisioned
`schema/related-view-defaults.json` manifest. IDs use `related:v1:` plus table hex.
Ordinary defaults are unaffected. `referencedBy` applies the selected query's
filters and sort before pagination, retains full live source rows, and preserves
target primary-key affinity/collation. Presentation columns and trash mode do not
hide required record fields or expose deleted links. For relative filters hosts
supply `calendar` using the selected definition's timezone/day policy. A deleted,
invalid or wrong-table pointer falls back to all live links with `viewUnavailable`;
absent unprovisioned related preferences retain existing link behavior. Reads never
create preference storage. Recognized preferences follow table renames via ordinary
logged writes/tombstones. Include this optional table in the client's sync scope.

Run `bun test` and `bun run check` here, or `just test` / `just check` at the
repository root. The shared `tests/fixtures/sync-protocol/revisions.json` cases
run in both Python and TypeScript; core tests also call the actual Worker over
its D1-compatible SQLite test adapter. No live dataset is needed.

The JSON boundary lives in `contract/core.json`. Run
`bun ../scripts/generate-core-contract.ts` to regenerate TypeScript models,
operation pairs, and Swift `Core` models. Check mode is read-only and part of
`just check`. The generator intentionally supports only the schema vocabulary
in use; unsupported constructs fail. Swift codecs preserve required nulls and
optional missing/null/value fields and reject integers outside JS precision.
`CoreRequests` couples each Swift request to its response type; TS `CoreHandlers`
requires every current operation. `createCoreHandlers` invokes existing core
behavior, including `readRows` and `readOptions`, with platform dependencies
injected. This is an in-process API, not a server RPC negotiation protocol.

Consumers vendor the schema, generator and generated artifacts together. The
contract SHA-256 identifies that local artifact pair; their bridge must compare
it with the bundled runtime before dispatch. Consumers retain queues, file/Web
locks, host-only database lifecycle, and notification checkpoints. Generation
adds no platform timers, storage, credentials or speculative scoped sync.

## Pure enrollment policy

`enrollment.ts` implements policy over the existing `/login` approval page and
GET/POST `/v1/session`. It performs no HTTP, SQL, credential access, cryptography,
clock reads or browser operations. The four generated dispatch operations are:

| Operation | Arguments | Result |
| --- | --- | --- |
| `enrollmentApproval` | `{ fingerprint, name }` | `{ path, approvalCode, deviceName, policy }` |
| `validateDeviceSession` | `{ data }` | `{ name, scopes, replica }` |
| `enrollmentPollResult` | `{ reply, expectedFingerprint }` | `{ state, session, retryAfterSeconds }` |
| `sessionRevocationResult` | `{ status, data, retryAfterSeconds? }` | `{ state }` |

Standalone exports use `validateDeviceSession(data)`,
`enrollmentPollResult(reply, expectedFingerprint)` and
`sessionRevocationResult(reply)`; the approval export takes the same arguments
as dispatch. These functions are also usable before a database is opened.

`enrollmentApproval` returns a relative `/login?key=...&name=...` path, an eight
hex-character approval code, and `device:<fingerprint>`. Only a lowercase
64-character SHA-256 fingerprint is accepted. The label matches the Worker's
`validLabel`: trimmed, 1-100 UTF-16 units, with ASCII controls/DEL rejected in
the original input. Encoding replaces unpaired surrogates like URLSearchParams,
without needing that global in JSC. Hosts validate/canonicalize and capture the
endpoint before appending this path. Never supply a bearer token as the key.

`policy` carries `pollIntervalSeconds: 5`, `timeoutSeconds: 300`, and
`maxResponseBytes: 65536`; the same frozen values are exported as
`ENROLLMENT_POLICY`. Host crypto generates a dedicated `lt_` token from 24 random
bytes encoded as hex and hashes the entire UTF-8 token. Native persistence is
in device-only Keychain, browser credentials stay session-only, and operator or
another client's credentials are never copied into enrollment.

`SessionReply` is `{ status: number, data: JSONValue, retryAfterSeconds?: number }`.
The host supplies the actual HTTP status and bounded parsed JSON on 200. For
non-success replies, policy ignores the body; hosts may supply `null`. Never
parse an error string to recover status. The host transport
uses the fixed session route, refuses redirects/cookies, enforces the response
byte bound, and sanitizes network/body parsing failures. Hosts supply this
fixed-route enrollment/session transport independently of the core Hub's raw
`governancePost` adapter.

Polling accepts 200 only after nonadmin session validation and exact
`device:<expectedFingerprint>` identity matching. Generic session validation
allows dedicated manual names. Name `admin` or an `admin` scope is rejected.
`SessionInfo.replica` is `{ allowed, reason }`, where a refusal has a stable
`code` plus a displayable `message`. Current replicas require scope `full`.
Absent capabilities remain compatible. An advertised `capabilities` object may
contain unrelated future keys; core ignores them. Only the recognized fields
are checked: `schema` must be a string and `replica_sync` a boolean when present;
`schema: "none"` and `replica_sync: false` refuse replica use. Invalid recognized
field/container types also refuse. No future positive capability values grant
permission in place of `full`, and core adds no capability fields to hub replies.

An `approved` result means the candidate identity authenticated; it does **not**
override a denied `session.replica`. Require `replica.allowed` before installing
credentials for Iris replica use. This is eligibility from the supplied
response, not a freshness guarantee about server authorization.

HTTP 401/403/429/5xx poll replies are `pending`; other statuses fail. Pending has
`session: null` and a retry delay of at least five seconds. For 429/503, an optional
host-parsed `retryAfterSeconds` (nonnegative safe integer) can extend that delay;
core never reads a clock or parses an HTTP date. Malformed HTTP Retry-After
headers should be omitted by the host. Hosts use a monotonic five-minute deadline,
cap waits to remaining time **before** converting units, and never issue another
poll or accept approval after timeout/cancellation/attempt replacement. Network
failures are host transport errors; malformed 200 replies are policy errors.
Core does not retry either. Hosts may explicitly retry transient network failures
at the policy interval within the original deadline; malformed replies fail the
attempt. Neither error can imply approval.

Session POST confirms `revoked` only for 200 with `logged_out: true`. A 401 returns
`unauthorized`: the existing hub cannot invalidate an unregistered, non-expiring
approval link. Best-effort cleanup on cancel/timeout can race later browser
approval, so never describe it as guaranteed revocation. Retain only public
fingerprint/device-management recovery instructions after discarding a candidate.
An approved but uninstalled candidate should be revoked if installation fails.
Normal logout revokes before deleting a saved credential, preserving it on remote
failure so retry remains possible. Hosts guard credential replacement and late
callbacks using the captured endpoint/attempt identity; policy has no session slot.

`tests/fixtures/enrollment-policy.json` supplies JSON operation cases and expected
results/errors for browser/JSC host conformance. Core also exercises real Worker
approval, session and revocation responses with isolated SQLite auth storage.
Python login production behavior is not changed, and no extra Python policy
implementation is introduced.

## Incoming references

`referenceSources({table})` returns each current incoming `ref` or `multi_ref`
column, its display label and an incompleteness flag. The metadata read does not
scan source records. Live deprecated columns remain relationships until their
catalog definition is deleted.

`referencedBy({table,rowId,sourceTable,column,limit?,offset?})` reads one group
locally. Pages default to 20 rows and reject limits above 100. `nextOffset` is
null at the end; returned rows contain the full record and its catalog display
label. Host panels should request groups on demand, discard stale responses and
use their existing fresh-row navigation path when a result is selected.

Comparisons follow the target primary key's affinity and collation, including
case-insensitive IDs. Repeated multi-reference values produce one source row;
malformed or non-array legacy JSON produces no match. Source tombstones are
excluded, while a target in Trash remains inspectable. Missing targets produce
no links. Skipped source or target tables mark the group incomplete, including
an empty result, so absence in a partial replica is not presented as certainty.

Reads use one local transaction and never fetch remote data or mutate user rows,
history, search indexes, sync cursors or pending edits. The ordinary core status
initialization may create missing internal state tables. Catalog/query failures
remain errors for the requested group. Pagination is bounded but is not a stable
snapshot across separate requests when another client edits records.


## Transferable read plans

`prepareReadPlan` prepares version 1 title-list or capped-count SQL for an ordinary
catalogued table, optionally using a selected saved view and its expected revision.
It uses the same `view.ts` compiler as eager reads. Calendar bindings are tagged at
their emission sites; literal values equal to today remain literal. The host supplies
stable opaque workspace/replica identities and resolves the saved timezone/day-start
policy at extension read time. Lists select only ID and configured display column,
at most 20 rows. Count probes at most 10,001 IDs; a value above 10,000 is a lower
bound rendered as `10,000+`. Nonempty FTS is rejected because read-only snapshots
cannot drain the indexing queue.

Guards contain exact ordered rows from schema, relevant catalog, selected view and
stored hub identity reads. These are collision-free structural fingerprints, not
cryptographic assertions. A trusted host must pair the plan with a coherent backup,
verify workspace/replica identity and policy, and compare all guards using exact
scalar/UTF-8 equality in the same read transaction as execution. The extension must
reject unknown versions, enforce one read-only statement per query, impose a query
work/cancellation budget, and bound decoded results. Metadata is limited to 256 KiB
of JSON code units. Core does not publish snapshots, claim replica completeness,
execute extension queries, or authorize untrusted SQL. Failed validation is not an
empty result; the host owns explicit unavailable/stale presentation and revocation.
