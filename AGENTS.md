# soma - agent instructions

Schema-agnostic personal data store: local-first SQLite + the `soma` CLI,
plus an optional sync hub (a Cloudflare Worker in `worker/`). The client is
Python 3.12+, standard library only - **no runtime dependencies, keep it that
way**. Built with uv; packaged as a Nix flake app.

## The user/dev boundary (load-bearing)

The repo ships FUNCTIONALITY, generic for any user. The owner's tables,
columns, and rows are STATE in the data dir, created through the installed
CLI.

- Operating on the owner's data ("add a property", "query people", "create a
  table", "import from X") = **user op**: use the installed `soma` CLI. Never
  open this repo for it, and NEVER add user-table schema (migrations, table
  definitions, seed data) or source-specific importers to this codebase.
- New capabilities and bug fixes = **dev work**: happens here, TDD, generic.

Saved-view v2 presentation metadata selects table, Calendar, Gallery or select-grouped
Board rendering. The canonical validator checks referenced live catalog properties.
`calendarRows` and `boardRows` are pure shared presentation operations over loaded
rows; they do not bypass query pagination or write records. Calendar hosts provide
civil-day bounds through the existing timezone/day-boundary contract. Date-only
range ends are inclusive and timed range ends exclusive. Unknown Board select
values remain visible after configured options, followed by the empty column.
An optional v2 `wrap` lists distinct catalogued columns whose cells wrap their full
text (absent: none wrap); like `widths` it is presentation only and never reaches the
query view, and a wrapped column missing from the catalog or schema makes the view
unavailable.

Per-table preferred-view IDs use the canonical `view-defaults/v1` manifest and
`getViewDefault`/`setViewDefault` operations. Writes require the displayed revision
and use normal validation/history/Undo; unavailable pointers fall back visibly
without rewriting user views. Plain table navigation calls `ensureDefaultView`:
without an available preference it creates or restores the table's deterministic
`catalog-default:v1:<hex>` saved view and points an absent or cleared preference at
it, so every table opens on a real saved view. It records no Undo receipt and falls
back to a plain read when either store is unprovisioned or unwritable. Explicit
destinations win. Provisioning is operator-owned, never implicit in reads.
A table's live saved views keep distinct names (trimmed, ASCII case-insensitive):
`saveView` refuses a new or renamed view, and Undo refuses a restore or rename, that
would collide with another live view (`views.name` violation, rule `unique`). Edits
that keep a view's stored name still save, so duplicates synced from another device
can be deleted or renamed rather than blocking autosave.

Related-record view IDs use the separate `related-view-defaults/v1` manifest and
`getRelatedViewDefault`/`setRelatedViewDefault` operations. This optional store does
not change ordinary default-view storage. Incoming references apply the selected
saved view's query filters and sort before pagination through the same compiler,
retain full live rows and target-ID collation, and show an unavailable-view fallback.
Relative filters require the host calendar context. Table rename rekeys both stores;
reads never provision either store or rewrite saved definitions.

## Layout

- `src/soma/__init__.py` - CLI, sync engine and hubs.
- `src/soma/background.py` - persistent CLI toggle, status and supervised loop.
- `src/soma/credentials.py` - native macOS Keychain storage; stdlib only.
- `src/soma/legacy.py` - adopts a pre-rename install on first use: the old
  `<data home>/life-data` dir (`life.db` -> `soma.db`, files already in the new dir
  win), the hosted hub's previous hostname in prefs and `_sync_state`, and a
  device token under Keychain service `life-data`. Tests isolate `XDG_DATA_HOME`
  (tests/conftest.py) because `main()` runs the adoption against the real home.
- Persisted protocol identifiers keep their original spelling: the
  `source=life-core` catalog marker of the views/pins/defaults manifests, the
  `life_*` SQL error codes raised by installed triggers, the `-- life-data-dump:`
  header old dumps carry (still read), and the `life-notification-v1` /
  `life-governance-v1` crypto domain tags. Renaming any of them strands existing
  estates, backups or tokens.
- `src/soma/login.py` - browser enrollment and device-token lifecycle.
- `src/soma/catalog.py` - the catalog engine: typed properties, rules,
  derivations, provenance, check/audit/infer/doc. Pure over a sqlite3
  connection.
- `src/soma/changes.py` - Python's local dirty-identity receipts. Temporary
  triggers exist only on supported local writer connections; no tracking trigger
  or receipt schema is logged or shipped to the hub or shared core.
- `worker/src/main.js` - the deployed entry: `worker/src/index.js` wrapped
  by `worker/src/usage.js` (usage meter, hard cap, notification feed).
- `worker/src/index.js` - the hub service; `worker/src/auth.js` owns the
  separate auth registry and `worker/src/login.js` owns the Access-gated
  browser flow. `worker/wrangler.jsonc` declares the main data D1, auth D1,
  R2 bindings, the `ChangeSignal` Durable Object and backup cron (those
  declarations ARE the provisioning).
- `worker/src/changes.js` - instant sync: the `ChangeSignal` Durable Object
  (one per hub) holds a change sequence. Open clients hold a hibernatable
  WebSocket on `GET /v1/changes`; older replicas long-poll the same route. It
  also sends the throttled silent APNs wake (see Apple push).
- `worker/src/backup.js` - the backup cron: D1 export API → gzip → R2
  retention tiers, with failure/recovery notifications.
  `worker/src/backups.js` - consumer `GET/POST /v1/backups` routes
  (`docs/backups.md`).
- `core/src/backup.ts` - the SQL dump format, `validateBackup`,
  `previewRestore`, `exportReplica`, `restoreReplica` and the hub backup
  clients. Rows are re-serialized from parsed literals; dump SQL never runs
  for data. `docs/backups.md` is the contract.
- `core/src/` - shared TypeScript validator, sync, write path, catalog, HTTP
  adapter and view compiler for UI clients. `core/README.md` documents adapter
  contracts and current boundaries. `worker/src/validate.js` re-exports the
  shared validator and adds hub-specific validation.
  `tests/fixtures/validation-cases.json` is the Python/TypeScript contract.
  The `date_or_datetime` TEXT property preserves either existing date-only or
  UTC-millisecond precision. Relative queries use the host calendar context;
  callers never truncate instants or turn all-day dates into midnight values.
  Core sync walks catalogs first, then each table after the tables its catalog
  refs point at (name order otherwise, `history` last), so a new row and a
  reference to it (a saved view and its `view_defaults` pointer) land in one round.
  The Python client (`_push_order`) also places each table after the tables its
  enforced table invariants read, so `overlay` follows every `txns_*` table.
- `core/src/source-links.ts` resolves explicit `table/id` identities against live
  catalog tables and exact row IDs, and supported Notion URLs through live,
  whole-record `imported_from` provenance. It never infers a destination from
  coincidental row IDs. Missing mappings stay external; ambiguous mappings fail.
  Hosts re-read the returned destination through their usual navigation guards.
- `core/src/references.ts` owns incoming catalog relations. `referenceSources`
  lists metadata without scanning data; `referencedBy` reads one bounded local
  group (20 default, 100 maximum). Identity comparisons use the target primary
  key affinity/collation. Source tombstones are excluded, target tombstones stay
  inspectable, and skipped source or target tables mark results incomplete.
  Hosts load groups lazily and re-read selected rows through guarded navigation.
- `core/src/table-pull.js` (with `table-pull.d.ts`) and its twin
  `src/soma/table_pull.py` - dependency-free consumer helpers consumers vendor:
  per-table cursors over `/v1/cursor` and batched incremental pulls. The JS
  tests run against the real Worker; keep both files in step.
- `core/src/services.ts` - typed usage/feed/read-state clients over `ServiceHub`.
  `tests/fixtures/hub-usage-contract.json` is the hub contract. Feed reads walk
  from zero each time; presentation checkpoints and permissions belong to hosts.
- `core/src/enrollment.ts` owns four pure enrollment/session policy operations.
  `tests/fixtures/enrollment-policy.json` is portable host conformance data,
  checked against actual Worker approval/session responses in core tests.
  Relative approval paths carry only a fingerprint; hosts own endpoint validation,
  crypto, typed HTTP replies, deadlines, cancellation and credential storage.
  A validated identity is not replica permission: require `session.replica.allowed`.
  A 401 cleanup result is unauthorized, not proof that later approval is cancelled.
  Python login behavior and hub routes are independent of these pure UI operations.
  `core/src/enrollment-scopes.ts` owns the profile grant grammar;
  `tests/fixtures/enrollment-scopes.json` is its contract with the Worker and with
  `valid_profile_scopes` in `src/soma/login.py`.
- `core/contract/core.json` owns the client JSON shapes and current operation
  pairs. `scripts/generate-core-contract.ts` emits TS types and prefixed Swift
  codecs, including named discriminated object unions; `--check` verifies
  reproducibility without writing. Governance operations require an explicitly
  injected canonical adapter and
  a validated current credential capability. Generated types alone never activate
  a service or a writer. Edit the contract,
  never generated files. `createCoreHandlers` keeps local dispatch behavior in
  TypeScript; hosts inject credentials, transport, locking and storage.
- `core/schema/sidebar-pins.json` owns durable table-pin storage. The contract
  generator packages its byte-exact Python resource; do not edit that copy.
  `soma table provision sidebar-pins` installs logged DDL/catalog metadata and
  refuses foreign collisions. Pin operations use ordinary validated writes,
  deterministic identities, revision guards and tombstones; reorder is locally
  atomic, while sync retains ordinary row-level LWW semantics. Recognized pins
  follow table renames through copy-plus-tombstone rekeying.
- `core/src/undo.ts` owns a bounded volatile stack of 100 undo receipts per `createCoreHandlers`.
  Capture is inside the existing write transaction; receipts publish only
  after COMMIT. Inverses use the same writer and captured revision/shape.
  Only the top receipt can be undone. Undo advances an earlier same-row receipt
  only when its full captured state exactly matches the state being restored;
  external writes never become a local baseline. Saved views use captured writes
  and revalidate their definition on restoration. No-op writes preserve the stack.
  Session mutations/status are queued; host-wide serialization still applies.
  Dispose handlers with the workspace. No undo persistence, history replay,
  redo or autosave grouping. Hosts preserve newer drafts and pause autosave
  during undo and until retained drafts are explicitly reviewed/saved.
- `core/src/governance.ts` plans selected-column historical inverses from
  trusted complete, commit-ordered typed evidence. It rejects later unselected
  same-column changes and produces no partial patch on conflict. No RPC,
  authorization, evidence loader, preview token, or proposal writer is supplied
  by this pure primitive; generated governance DTOs are not service capabilities.
  Mutation errors carry required original-operation `resolution`; an unresolved
  retry rejection cannot clear a pending journal. `not_committed` requires a
  durable negative receipt excluding late execution, not just an HTTP error.
- `worker/src/governance.js` implements the nine configured governance HTTP
  handlers over the existing checked writer. Private immutable versions,
  canonical typed evidence and terminal receipts live in the data store;
  authenticated approval authority remains in the separate auth store.
  Preview performs a rollback-only validation probe and never initializes,
  meters, schedules or persists work. Proposal versions cannot silently rebase.
- `worker/src/changeset.js` prepares bounded trusted-service create/patch/soft-delete
  sets with explicit authorization, absence/revision guards and one transactional
  receipt read. Callers supply complete displayed dependency/membership reads.
  `prepareChecked(..., {finalState:true})` returns `checks` that MUST execute after
  every table's mutation and before cleanup; use `commitChangeset` for composition.
  Catalog invariants receive full native before/final sets, while ordinary writes
  retain per-mutation validation.
- `worker/src/changeset-governance.js` exposes the separate
  `bounded-changeset-proposals-v1` capability under `/v1/governance/changesets`.
  Configured broad-read agents can preview/propose; only authenticated USER actors
  with current broad read/write and approval authority can approve. Operators and
  narrow grants do not gain authority. Frozen proposals, principal-bound previews,
  explicit expected read membership, complete mutated-table continuity guards and
  original-key positive/negative receipts protect one atomic final-state result.
  Previews never persist domain/auth usage/proposals/history or outbound effects.
  Limits are advertised and reject wholly, never chunk. Capacity and writer-budget
  refusals return HTTP 422 validation_failed; configuration/service outages remain
  unavailable. Preview capacity is also bounded by its sealed before/after payload,
  so request bytes alone do not guarantee acceptance. Provenance is insert-only.
  Purges redact dependent proposals/receipts while retaining retry exclusion.
  Generated DTOs and `parseChangesetApproval` validate whole-set client receipts;
  hosts still need actual USER enrollment and a durable captured-scope journal.
  Existing single-row governance and its clients retain their own protocol.
- `worker/src/write.js` exposes `prepareChecked` for trusted service composition.
  It prepares table approval/history setup, mutations and cleanup without running
  a batch. All shared read guards must execute before every plan setup, and all
  participating plans must commit in one batch. `commitChecked` remains the
  ordinary single-table interface. Preparation alone grants no consumer writer.
- `worker/src/governance-store.js` inserts terminal receipts in the same batch
  as mutation. Unique key exclusion also makes negative settlement durable.
  Replays reauthorize current disclosure before returning the original result,
  ahead of current row/catalog validation. Purge removes affected proposal
  versions and receipt payloads, retains exclusion keys, and revokes outstanding
  stateless previews with a private target invalidation nonce.
- `worker/src/governance-continuity.js` installs permanent mutation guards on
  ordinary base tables. Indirect writes and lifecycle changes invalidate history
  continuity and preview bindings. Exact stored table DDL detects column identity
  changes; guard reinstallation breaks prior proofs. Only the checked writer with
  verified trigger topology records typed evidence under transaction-local private
  context. REAL evidence stays in native REAL columns, not SQLite JSON decimals.
- `worker/src/governance-isolation.js` reserves `_governance_*` state from generic
  schema/row/purge/catalog-SQL routes, including broad credentials. Private SQL
  shapes and history invalidation triggers require exact service-owned DDL.
  Schema replay accepts DDL, never arbitrary data SQL or PRAGMA statements.
  Configured handlers require `GOVERNANCE_DEPLOYMENT_ID` and a separately
  purposed `GOVERNANCE_PREVIEW_KEY`; see `docs/governance-service.md`.
  Generated DTOs alone do not activate an adapter or advertise this protocol.
- `core/src/search.ts` owns local FTS5/unicode61 search and its durable
  `_core_search_*` cache. Exact queue-only triggers capture writes and pulls,
  including independent Python edits. Only `searchIndexStep` builds the index,
  in budgeted, resumable chunks hosts run after rounds, writes and while idle;
  reads never build it (they index at most one queued batch once it is current). Provenance and size-rule tables are left out unless
  `_core_state` `search_tables` opts them in. Cache DDL never enters `_schema_log`. `View.search`
  uses literal word prefixes; `contains` retains substring semantics. Raw
  Markdown is indexed, with conservative plain-text display cleanup only.
  Results list read-only system tables (`isReadOnlyTable`) after user tables,
  then order by relevance.
- `core/src/mentions.ts` owns `iris://table/<table>/row|view/<id>` links
  (percent-encoded, parentheses included) in Markdown bodies. The search
  index step also fills `_core_search_mentions` from live rows' `markdown`
  properties, so backlinks need no logged schema: a missing table resets the
  whole cache and the next step backfills it. `mentionedBy` pages live
  mentioning rows by table/label (self links excluded, any skipped table marks
  it incomplete, `indexing` while the step is behind); `mentionLabels` resolves live display labels (null = gone);
  `viewEmbed` previews one saved view (id plus up to five scalar columns) and
  returns `calendar` when the host must repeat it with that day policy.
  `resolveSourceLink` opens row links like `table/id` and returns `view` for
  live saved views. `listViews` without `table` lists every table's views.
- `core/src/remote.ts` provides transient read-only `remoteRows`/`remoteRow`
  operations through the existing paginated rows/pull API, one request each.
  Durable endpoint binding and known local table schema are checked before
  HTTP and again before returning rows; nothing is initialized or merged.
  Opaque cursors bind endpoint/table/schema. Full known columns, core labels
  and explicit tombstones are returned; SQLite checks ID order/equality with
  the actual column collation and no source-row scan. Hosts keep remote mode
  separate from local edits/search and deduplicate IDs across changing pages.
  No coverage, count or snapshot guarantee follows from browsing; usage caps
  still apply and core never retries. The bridge contract owns both operations.
- `core/src/view.ts` compiles bounded AND/OR groups, runtime Today operands and
  option-rank sorting. Version 2 saved definitions retain groups, an optional
  timezone (absent means the reading device's current zone) and optional
  `dayStartMinutes` (integer 0..1439, absent means midnight). `calendarPolicy`
  is the one rule for which views need a host calendar; its `timeZone` is
  omitted when the host should use its own zone. Hosts
  supply consecutive local policy boundaries on each query, never persist the
  calendar, and refresh at the boundary/resume. Resolve a DST gap to the next
  valid local instant and a repeated boundary to its first occurrence. The
  date label belongs to the interval's start; source timestamps stay intact.
  Multi-select order uses the first selected
  option; unknown/empty values trail known ones. Version 1 remains supported.
- `core/src/catalog-edit.ts` owns explicit property/rule edits and their atomic
  `catalog_log` entries. It shares storage/coverage guards with record writes,
  preserves displayed revisions and compiles rule SQL through the driver.
  Only an explicit new-property request adds a nullable logged column;
  catalog editing never rewrites existing record values or provisions missing
  engine storage. Ordinary record writes still reject catalog tables.
  Option items are `{v, d?, sort?, color?}`: `color` is one of the ten Notion
  palette names (`OPTION_COLORS`: default, gray, brown, orange, yellow, green,
  blue, purple, pink, red), trimmed and lowercased by catalog edits and
  `soma property set`; a null color clears it. Hub option metadata
  (`/v1/catalog/options`, `/v1/catalog/projection`, `publicOptions` in
  `scopes.js`) passes palette colors through and drops any other value.
  `scripts/notion-option-colors.py` is the idempotent one-off that copies
  Notion option colors onto migrated catalogs from an operator-supplied
  table -> data source map, through `soma property set`.
- `core/src/saved-views.ts` recognizes operator-provisioned ordinary synced
  `views` storage from the canonical DDL/catalog manifest
  `core/schema/saved-views.json`, also checked against the Python operator CLI.
  Clients vendor the same manifest with their bundle; it contains no definitions.
  `views.definition` has the catalog marker
  `source=life-core`, `source_ref=saved-views/v1`; all actual definitions live
  in table rows. Never auto-adopt a name collision or provision in the client.
  Saved edits/deletes use the normal write path and require selected revisions.
  The Python rename path updates recognized `views.tbl` in its transaction,
  advancing each affected revision beyond its previous value and at least to
  database time so LWW and push discovery retain the rename under clock skew.
  Returned view columns are SQL projection: clients need full rows to edit.
- `core/src/row-actions.ts` validates version 2 literal action patches and layout
  references. `runRowAction` resolves the current definition and full live row
  under the mutation session's writer transaction, requires both the displayed
  saved-view `expectedViewUpdatedAt` and selected row `expectedUpdatedAt`,
  and publishes an ordinary undo receipt only after commit. Keep identity,
  clocks, deletion, derived and immutable fields out of action definitions.
  Actions use ordinary catalog/history/coverage checks and pending sync state.
- `syncStatus` includes durable `skippedTables` from the last completed pull
  round, stored in the final ready transaction even when pushes are rejected.
  `last_sync` records every completed round; rejected rows wait in the inbox
  and count separately. Hosts consume this
  warning after reopen; they do not persist exclusions or certify coverage.
  The existing `_core_state.skipped_tables` JSON key remains compatible.
- `core/src/rejections.ts` owns durable inbox reads through the generated
  `rejections` operation. Bounded offset pages preserve exact IDs, submitted
  snapshots and raw hub error objects. Reads never initialize or modify storage;
  malformed entries fail the page without cleanup or payload-bearing errors.
  Hosts use this operation instead of decoding `_core_rejected` themselves,
  restart pagination after sync, and fetch a current full row before repair.
  Correction saves use the normal writer; only accepted sync clears rejection.
- `core/src/write.ts` shares table guards with advisory `writeability` and runs
  deterministic table invariants with one-row SQLite `before`/`changed` contexts
  and a captured `now.ts`. Custom triggers, estate enforcement and all declared
  SQLite FKs remain blocked, including NO ACTION/RESTRICT and disabled FKs;
  catalog references keep their ordinary validation. Only complete canonical
  main timestamp triggers with quoted or unquoted identifiers are accepted.
  Trigger names are independent of table names after SQLite renames; the entire
  body must still target the actual table. Temporary triggers, stale targets and
  modified bodies remain unsupported.
  Adapters must allow read-only `main/temp.foreign_key_list` introspection.
  `core/src/coverage.ts` owns local `_core_coverage` certificates: successful
  full pulls and certified incrementals only, endpoint/schema/cursor/version
  bound. Unchanged incremental refreshes retain prior proof across interruption;
  schema/catalog changes revoke metadata trust before application and stay
  blocked until complete certification. A pull cursor survives schema changes
  to other tables (only replayed DDL touching a table forces its full pull);
  each finished table commits its cursors at once and `_core_pull_progress`
  resumes an interrupted table at its last page, so a host round deadline or
  one failed request never restarts finished work. Bound replicas require trusted catalog
  metadata even when no invariant is currently present. The optional driver
  `readDependencies(statements, { ownedTempTables })` uses SQLite compiler
  metadata, without execution, to narrow invariant coverage to target/catalog,
  reference and SQL validation reads. Null/unexplained metadata fails closed;
  an absent method retains full-global coverage, including history/provenance.
  Standalone unbound tables without enforced invariants remain editable.
  `tests/fixtures/read-dependencies.json` owns host conformance cases. Core owns
  temporary snapshot creation/cleanup, bounds preparation, and never caches
  dependency sets persistently. Coverage is neither freshness nor a simultaneous
  remote snapshot. Legacy cursors and unbound files grant no proof.
  Certificates/refresh state never sync or enter logged DDL.
- `scripts/cf-r2-lifecycle.py` - idempotent source of truth for backup
  retention tiers.
- `tests/test_core.py` - pytest: CLI, sync engine, hubs. `tests/test_catalog.py`
  - pytest: the catalog engine, sharing `tests/fixtures/validation-cases.json`
  with `worker/src/validate.js`. `worker/test/` - bun test over a
  `bun:sqlite` D1 shim. TDD: failing test first, then mutation-test (break
  the code, confirm the test fails).

## Conventions

- HTTP replica pulls request pages of 200 using an `after` row-id cursor;
  `since` stays fixed for the entire walk. The hub returns `next_cursor`
  only for paginated requests. Legacy requests retain complete responses.
  `/v1/cursor` advertises `pull_batch` (`{items, rows, bytes}`): `/v1/rows/pull`
  then also takes `{batch:[pull, ...]}` (each pull paginated) and answers
  `{batch:[page, ...]}` from one D1 batch. Past the byte budget it stops after
  at least one row and answers a prefix; a cut page's `next_cursor` is the last
  row sent. Core uses it; the Python client still pages one table at a time.
  Consumers without a replica read through the table-pull helper
  (`core/src/table-pull.js`, `src/soma/table_pull.py`; docs/consumer-access.md):
  one cursor request per quiet round, then batched incremental pulls.
  A failed or nonadvancing page aborts before the sync cursors advance.
  Pull pages and push chunks retry a 5xx, timeout or dropped connection up
  to three times (`RETRY_DELAYS`); refusals never retry.
  An optional `where` object (column → string or number) adds equality
  filters, so a consumer can pull one slice of a large table.

- Data dir: `$SOMA_DATA_DIR` > `$XDG_DATA_HOME/soma` >
  `~/.local/share/soma`; the database is `soma.db`. Nothing else may
  hardcode a path.
- `soma table create` injects sync columns (`id` hex PK, `created_at`,
  `updated_at` + trigger, `deleted_at`) and writes a `catalog_properties` row
  per column from its typed `col:type[!][(a|b|c)]` syntax. Repeatable
  `--description COLUMN=TEXT` supplies descriptions in the same transaction
  as the table, trigger, catalog rows and DDL log. Explicit enforced table
  invariants on `catalog_properties` check local setters, raw edits and hub
  pushes; user-specific policies stay in runtime catalog rows. `soma check`
  supplies the full table as `changed` for an estate audit, while mutations
  supply only actual changed identities. DDL through `soma sql` is recorded verbatim in
  `_schema_log`; ordered replay is how schema syncs. Underscore-prefixed
  tables are plumbing - created by `init()`, never logged.
- Timestamps: ISO 8601 UTC with milliseconds via SQLite
  `strftime('%Y-%m-%dT%H:%M:%fZ','now')`. Sync ordering depends on
  lexicographic == chronological; keep every new timestamp in this format.
- **Always invoke uv through `just`, never bare `uv run`**: the justfile puts
  the venv outside iCloud (`UV_PROJECT_ENVIRONMENT`). Bare `uv run` uses
  `./.venv` under iCloud, where macOS intermittently stamps the editable
  install's `.pth` UF_HIDDEN and Python 3.13+ silently ignores it
  (`ModuleNotFoundError: soma`). If it strikes anyway:
  `chflags nohidden .venv/lib/python*/site-packages/*.pth`.
- `just` verbs: `run`, `test`, `check`, `fmt`, `deploy`.
- **Writes are validated.** `execute_sql` and `insert_rows` run inside
  `catalog.write()`: one transaction, every changed row checked in every table
  that has catalog properties OR is named by an invariant, `ValidationError`
  after ROLLBACK. Client writes reserve the writer with `BEGIN IMMEDIATE`
  before catalog reads and validation snapshots, so another writer cannot
  invalidate the snapshot before its first mutation. Connections wait up to
  60 seconds for a competing writer, including bulk sync transactions.
  **Changed rows come from the per-table `temp._before_<t>`
  snapshot diff, never a timestamp comparison** - a clock collision at
  millisecond resolution cuts both ways (an untouched legacy row looks
  changed; an UPDATE inside the same millisecond moves no `updated_at`). Only SELECT/PRAGMA/EXPLAIN/VALUES bypass it - a CTE
  (`WITH …`) does not, since it can end in INSERT/UPDATE/DELETE; a read-only
  CTE just pays a no-op transaction. Sync's pull upsert bypasses it on purpose
  (pulled rows were validated where they were written). The hub validates
  pushed rows per row and never fails a batch, **each against the MERGED row**
  - the stored row with the pushed columns applied. A push carries only the
  columns it writes, so whole-row rules (`required`, and the derived/immutable
  protections' notion of "changed") judge the row as it will BE: every required
  column is demanded in full only on an INSERT, and setting one to null is
  still rejected. Per-value checks (type/options/pattern/ref) judge only the
  columns the payload carries - a stored value is not this write's claim.
  `validateRow`'s `touched` option is what draws that line, and the shared
  fixture covers both sides of it.
  The Worker resolves existing rows and references in bulk. LocalHub holds
  BEGIN IMMEDIATE while validating, sparsely upserting, checking actual values,
  running enforced invariants, and logging history, with a savepoint per row.
  The Worker captures validation reads and asserts them unchanged inside its
  D1 transaction. Ordinary triggers created and dropped in that batch check
  actual NEW values and enforce invariants with OLD/NEW CTE contexts. INSERT
  defaults are resolved once, validated, and stored explicitly. Physical column
  affinity normalizes approved values. References/options_sql run at each
  mutation to observe earlier accepted rows. Read assertions run before helper
  DDL using SELECT CASE and SQLite integer overflow on mismatch. Read/approval
  JSON snapshots use bounded UTF-8 chunks; a guard's UNION ALL nests in groups
  of five, D1's compound SELECT limit, which the LimitedD1 test fixture also
  enforces. Read guards retain whole-result
  multiplicity and binary comparison; oversized encoded rows or exhausted JSON
  binding capacity use native cells and global counts within 99 parameters.
  A native row wider than the remaining bindings fails with the write budget.
  Large stored approval text and non-integral/unsafe numeric values stay native;
  this does not raise D1's individual value limits or bound incoming row/history
  payloads. A failed
  invariant rolls back the batch; ordered splitting isolates rejected rows and
  revalidates duplicate IDs against earlier accepted state. Unexpected SQL
  failures roll back the submitted batch and surface as errors.
  Each pushed updated_at must be a real calendar timestamp in exact UTC
  millisecond form, independently of the catalog. Missing, null, unlisted,
  malformed, non-UTC or non-millisecond stamps reject per row. Stale/equal
  revisions do not change values or generate new hub history.
  Table writes/derivations require Workers Paid (1,000 D1 queries/invocation).
  Pushes budget 750 SQL statements, background derivations another 200, and
  direct/scheduled derivations share 900 across all nested callers, including
  precommit reads. Exhaustion preserves committed progress and reports pending
  work in failed; subsequent calls/sweeps resume. A derivation starts only while
  the remaining budget covers the costliest one so far, so an external call is
  never made for a commit that cannot fit; freshness is judged in bulk (two
  reads per 200 rows, one rendering per distinct input list). SQL text is bounded at D1's 100KB limit. Typed history uses bounded trigger bodies, keeping each cell's evidence sequence intact and all triggers in the same mutation transaction. Ordinary 500-row writes use bulk
  upserts. Budget exhaustion is retryable per row; sync leaves its push cursor
  unchanged whenever any row rejects. Core and Python sync re-push
  `write-budget` and `retryable` rows in halved batches within the round, so
  only a row that still fails alone rejects.
- **Checks must be pure; producers may touch the world.** Invariant SQL is one
  SELECT. Core/Worker share `core/src/rule-sql.ts`; Python mirrors its fixture.
  The conservative text screen rejects date/time functions (even explicit-input
  forms), CURRENT_DATE/TIME/TIMESTAMP, randomness, connection-state functions,
  `localtime` and `'now'`. Compare or slice `(SELECT ts FROM now)` directly;
  `changed`/`before` are engine contexts. This is not a parser or proof of
  determinism through views/custom functions; rule authors must keep those
  dependencies deterministic. Defaults are separate from invariant SQL. Audits run
  via `soma audit`. **Derivations are `http:<name>` and run on the hub only**:
  a client never writes a derived column (any write that changes one is
  rejected locally and again at the hub), and the hub verifies
  `provenance.inputs_hash`/`value_hash` against the pushed row. **A
  derivation's `inputs` must be cataloged columns** - both sides hash one typed
  rendering, identical for a stored cell and a bound value (`canonicalSql` in
  `worker/src/validate.js`, `canonical_text` in `catalog.py`): a `number` is REAL
  text (4 → `"4.0"`), every other type renders an integral REAL as an integer,
  because D1 binds every JS number as a REAL (a stored 1999 rebinds as 1999.0).
  Proofs in the earlier all-REAL rendering (`"1999.0"`, also written by external
  writers matching it) are accepted alongside, so they stay fresh unrefetched.
- Every temp table the rule engine makes (`now`, `changed`, `before`,
  `_before_<t>`) is schema-qualified `temp.` - unqualified names fall through
  to `main`, so an unqualified DROP would delete a user table of that name.
- **Every table/column name interpolated into SQL is quoted**: `qi()` in
  `__init__.py`, `qident()` in `worker/src/validate.js` (both validate against
  `^[A-Za-z_][A-Za-z0-9_]*$` and refuse anything else rather than escaping it).
  A column named `cast` or `order` is otherwise a syntax error that breaks sync
  for the whole table. User-authored SQL (rule `sql`, `options_sql`, `sql:`
  defaults, `--where`) is left alone - that is the user's own SQL. The JSON
  path inside the upsert (`json_extract(value, '$.<col>')`) takes the RAW name:
  it is a JSON key, not SQL.
- `catalog_*` and `provenance` sync before every other table.
- **`history` is the engine's edit log**: original random IDs identify cell
  events. Local SQL writes, direct hub pushes and derivations log actual updates
  transactionally. Inserts, noops, stale/replayed writes, catalog, provenance
  and updated_at/hub_at churn generate no new hub events.
  Sync attaches original local events through the optional `history` list on
  rows/push. The hub validates and deduplicates these facts by ID, never
  rewriting an existing event. A single-transition whole-trail check is linear.
  Multiple revisions use bounded backtracking (10,000 generated states) to match
  disjoint paths and revisit earlier choices, without ordering tied timestamps
  or reusing an original for distinct updates. Proven no-match reconciles;
  needing more search states rejects the WHOLE request as history-ambiguity,
  retryable=true, with no values/history committed and an empty hub_at. Split
  revisions into smaller requests to retry; sync keeps its push cursor unchanged.
  History-bearing D1 failure isolation uses rollback-only prefix probes, then
  commits accepted rows together. All probes count toward the same query budget;
  their final named CHECK failure rolls back helpers, values and history.
  A differing concurrent OLD preserves LWW and original events, plus
  one `hub:reconcile` cell transition. Stale rows may import unseen originals.
  Failed validation/invariants roll back both row and attached history.
  Ordinary history-table sync remains as an ID-idempotent fallback for old
  servers that ignore attachments. History sorts last, and events belonging
  to rejected mutations are withheld. Old clients do not attach history, so a
  new hub may log their transition before original random-ID events arrive;
  legacy compatibility is explicitly best effort. Upgraded replicas supplying
  originals receive the dedup guarantee; old or uninventoryed replicas can
  duplicate aggregate/original history until upgraded. Never infer away or
  delete original events, add client registries/gates, or require new endpoints.
  The one exception is a purge marker (below).
- **`purges` is the only hard delete.** `soma purge <tbl> <id> [--col c]` writes
  a content-free marker (id `json([tbl, row_id, col])`, `purged_at`) and
  deletes, wherever a marker is applied, the row, its history and its
  provenance edges (col NULL) or that column's history - only what is stamped
  at or before `purged_at`. Markers travel through ordinary rows/push and
  pull: the hub applies them on push (`worker/src/purge.js`, mirrored by
  `apply_purges` in `__init__.py`), replicas pull `purges` before any other
  table and apply it, and both drop covered copies from pushes (rows,
  `history` rows and attachments) without rejecting them, since a rejection
  would pin an old replica's cursor. After accepting a push the hub re-applies
  the markers covering those rows (its own logged event for the edit carries
  the old value), and replicas filter covered rows out of every pull. Inserts are not filtered. Purging again
  moves `purged_at` forward to cover a re-import. Only `soma purge` writes
  `purges`; engine tables are never purge targets. Keep both implementations
  in step.
- **A soft-deleted row is never validated** (its cells are history, not a
  claim), but its cell changes are still logged.
- **`rename_table` is the only table rename.** `execute_sql` refuses
  `ALTER TABLE … RENAME TO` (the guard is `RENAME_TABLE`; RENAME COLUMN stays
  allowed). The verb runs one `catalog.write(ddl=True)`: the ALTER, a
  `DROP TRIGGER IF EXISTS` of the old-named trigger and a CREATE of the
  new-named one (all logged, so they replay), then `catalog.rename_refs`:
  id-keyed rows whose id embeds the table name (`catalog_properties`
  `<tbl>.<col>`, `catalog_tables`, derived `provenance` `<tbl>:<ref>:<field>`)
  are REKEYED - copy under the new id, soft-delete the old - because an
  in-place id change would leave the hub's copy alive and pull it straight
  back; `ref_table`, rule `tbl`, edge `to_kind` and `history.tbl` are plain
  updates; rule `sql` and `options_sql` are rewritten by word boundary, and
  the DDL recompile in `write` rejects the rename if any rule still fails.
  Replay skips a RENAME TO whose source table is already gone
  (`_already_applied(exc, ddl)`; the hub mirrors it).
- **`provenance` is ONE table for every value's origin.** Hub derivations
  write rows with `rel='derived_from'`, `asserted_by='hub'`, `from_kind =
  'http:<name>'`, `from_ref = _source_ref ?? inputs_hash`, id
  `<to_kind>:<to_ref>:<field>`, plus `inputs_hash`/`value_hash`/`produced_at`
  and `detail` `{"no_data":true}` for a lookup that completed without data.
  Clients write observation edges into the same table (a text, an email, a
  photo, an import backing a row or one column: `rel` evidence_of /
  mentions / imported_from, `field` = the column or NULL for the whole row,
  `detail` = pair-only JSON, id `<from_kind>:<from_ref>:<to_ref>`). It is
  engine-created (`CATALOG_TABLES`, last so its cataloging can log) but NOT
  in `ENGINE_TABLES`: it is cataloged from birth (`PROVENANCE_PROPERTIES`
  adds the descriptions and the two `options_sql` - every `derived_by` is
  automatically an allowed `from_kind`, every user table an allowed
  `to_kind`) and validated like a user table on both sides. Schema replay
  also skips `no such column` (a RENAME COLUMN a fresh replica's
  current-shape engine table never had).
- **`with connect(...)` CLOSES the connection** (`_Connection.__exit__`).
  The stdlib context manager only commits, and a sqlite3 connection sits in a
  reference cycle, so an un-closed one holds `soma.db`/`-wal`/`-shm` until
  the cyclic GC runs; a sync opens hundreds, and launchd caps a daemon at
  256 files. Never hold a connection past its `with` block.
- **Background sync is opt-in app state.** `soma background enable|disable|status`
  operates independently from the immutable installation defaults in config.json.
  The exported module runs `soma background run`, which waits without contacting
  the hub or credential provider while disabled. Credentials are generic env,
  a background-only command, or an explicitly saved macOS Keychain token.
  Never inherit an interactive token command into the runner. Retry failures
  in-process from 15s doubling to 120s (5s for a locked database); a round
  that must fetch the credential again (none yet, 401/403) doubles to 3600s,
  because a credential command's budget is finite. Never restart to fetch
  credentials again.
  Background Keychain reads disable native UI for that call and restore the
  previous process allowance, returning an OS code when interaction is required.
  Status distinguishes authenticating from syncing. Only a rejection-free sync
  advances last_success. Status holds counts and sanitized error classes; the
  log adds a transient failure's bounded message (300 characters, e.g. a hub
  5xx body) and, for a rejected round, counts per table, column and rule.
  Neither holds token values, row ids or rejected row payloads.
- **Device login is app-owned.** `soma login` opens an Access-gated approval
  page and saves the resulting scoped device token in the macOS Keychain;
  `soma logout` revokes it at the saved hub before deleting the local item.
  `--profile <id>` enrolls with a hub-configured profile instead of full access.
  Server consumers use the headless two-step form: `--profile <id> --start
  <state>` writes a candidate token to a new 0600 state file and prints the
  approval URL without contacting the hub; `--claim <state> [--wait]` checks
  once (or polls 5 s / 300 s), prints only the approved token, then deletes the
  state file. Neither step touches Keychain. A claimed session that is not
  exactly the requested profile on that candidate is revoked.
  The worker's auth registry is a separate `AUTH_DB` binding, so user schema
  DDL in `DB` cannot alter token state. `LOGIN_ACCESS_AUD` must equal the
  provisioned Access application's audience. `/login` never trusts identity
  headers and no login route accepts a bearer token in the browser URL.
- `just test` runs pytest AND `bun test` in `worker/` and `core/`.
  The deploy workflow gates deployment on all three suites.

## Sync internals

HTTP sync binds cursors to the endpoint after a successful round. An unbound
replica performs a full sync once; another endpoint requires a fresh data
directory. Never reuse cursors from an unknown or different hub.

State-based, never op-log. `sync(path, hub)`: `ensure_hub_at`, replay missing
`_schema_log` DDL both ways (idempotent-by-skip on "already exists" /
"duplicate column"), snapshot push candidates BEFORE applying the pull (else
pulled rows echo straight back), pull then push, then advance the
per-direction cursors in `_sync_state`; any rejection keeps last_push unchanged.
A per-database file lock inside the shared sync entry point excludes overlapping
manual, watch and background rounds, including endpoint-binding races. Final
cursor/binding state commits together. Preference updates use a separate short
lock; native credential access and network work never run under that lock.

**The two cursors measure different clocks.** `last_push` is the local clock
captured under BEGIN IMMEDIATE with push candidates and original history. The
candidate boundary is inclusive (`updated_at >= last_push`), supplemented by
the local `_sync_dirty` identities; remote row timestamps
never choose this checkpoint. Release the SQLite writer reservation before any
network work. Older checkpoint versions receive one resumable reconciliation
(below), recorded only after success; a detected clock rollback forces a full push. Explicitly
backdated imports are discovered through transactional dirty receipts. Equal
revisions and conflicts with newer hub revisions retain LWW semantics. `last_pull` is **`hub_at`, the
arrival time the HUB stamps on its own clock** - a nullable TEXT column on
every synced table, added by `create_table` and backfilled into existing
tables by `ensure_hub_at`. That migration is logged DDL, so it replays to the
hub and every replica, and it carries a **literal `DEFAULT '<stamp>'`** so all
of them backfill existing rows to the SAME value - a plain `ADD COLUMN` leaves
NULLs, the hub's `max(hub_at)` cursor stays empty, and every sync re-pulls the
whole estate forever. A table that just gained the column also resets
`last_pull` to `''` for one full pull. Clients
never write it: `upsertSql`/`_upsert_sql` bind the hub's own `strftime` in its
place on insert and in `DO UPDATE SET`, and hub-side derivations re-stamp it.
**Whether to stamp is read off the HUB's own schema (`PRAGMA table_info`),
never off the pushed column list** - an un-upgraded client omits the column and
its rows would land unstamped, invisible to every replica whose cursor has
moved on; on a table that has no `hub_at` the hub degrades to the old
`updated_at` behaviour for cursor and pull rather than erroring. The pull
boundary is INCLUSIVE (`hub_at >= since`): a push landing in the same
millisecond as a cursor read must not be lost, and re-reading the boundary row
costs nothing. A NULL `hub_at` is older than everything, so `since = ''` pulls
the whole table. The database clock is evaluated in the committing batch, including generated and
imported history arrivals; do not bind a pretransaction timestamp. Under a
nondecreasing hub clock, committed arrival order follows this clock: a replica that
pushes an edit stamped older than another replica's cursor still gets a fresh
`hub_at` and reaches everyone. `updated_at` decides row conflicts; `hub_at` decides
remote arrival discovery.

Python local writes install connection-local INSERT/UPDATE triggers on syncable
tables, including uncataloged tables and catalog metadata. `_sync_dirty` retains
one identity per table/row with an increasing sequence, never row payloads.
Snapshots capture a sequence boundary under BEGIN IMMEDIATE. The successful
final checkpoint transaction clears only receipts at or before that boundary;
failure/rejection retains them and later writes survive an older acknowledgment.
Pulls and LocalHub writes do not install these triggers. Local and replayed
table renames carry dirty identities to the new table. Checkpoint version 3
performs one reconciliation to recover imports missed before tracking: a full
pull compares each hub page with the local rows in its id range and pushes
only rows the hub lacks or holds older, plus dirty rows and rows written since
recovery began. `recovery_*` keys in `_sync_state` hold its starting pull
cursor and per-table page progress, so a failure resumes at the failed page
and the final `last_pull` still covers arrivals in tables verified earlier.
Completion or any rejection clears them; a rejection rescans from the start.
An unbound replica's first HTTP sync keeps the plain full pull and push.
TypeScript `_core_pending` remains that client's separate receipt mechanism;
direct external writers retain the timestamp compatibility contract.

**Every hub request pays its D1 round trips (~45 ms each from the edge).**
Idempotent setup (auth registry, plumbing tables, each table's arrival column)
runs once per isolate. Governance setup (continuity guards, private storage) is
a function of the schema: every other route runs the exact generic-state audit,
and an isolate that has run setup skips it while the audited schema (all of
`sqlite_master`) is the one it ran against; a replay, a DDL route or DDL from
outside the hub runs it again (`ready` in `index.js`). The platform spreads
requests over many isolates, so most writes land on one that has never written
and pay setup: its idempotent DDL and continuity reads travel in batches (about
six round trips), and each run logs one `governance_setup` line with its reason. Replica reads (`rows/pull`, `cursor`,
`stats`) skip setup and re-audit only when a one-row schema stamp (object
count, total SQL length) moved since the isolate's last passing audit; a failed
audit drops that verification, and reads execute no catalog SQL. The token
lookup and its governance authority are one AUTH_DB batch; a token's last-use
stamp is written at most once a minute. `worker/test/request-cost.test.js`
holds the per-route budgets (a warm read is three round trips plus the usage
flush after the response); a cold download is dozens of these requests.

**The hub owns a `hub_at` index per user table** (`<table>_hub_at`, unlogged
like the engine indexes, ensured once per isolate on cursor/pull and again
after schema replay). D1 bills rows READ, and every sync round runs
`max(hub_at)` plus a pull on every table: unindexed, that is two full scans of
the whole database per poll (a 416k-row provenance table every 30s cost ~$20 in
overage in one billing period). The incremental paginated pull must range-scan
that index: it writes `+id > ?` / `ORDER BY +id` so the planner cannot pick the
primary key and filter `hub_at` row by row; a full pull (`since = ''`) keeps
paging by `id`. `worker/test/pull.test.js` asserts both query plans - keep it
green when touching the pull SQL.

**The pull cursor is `hub.cursor(tables)` (`max(hub_at)`) read BEFORE the pull
loop, not after it**: the hub writes rows itself (derivations on push and on
the sweep cron), and a row it writes between a table's pull query and a cursor
read taken after the loop would carry `hub_at <= cursor` yet never have been
pulled - silently skipped by every later sync. Reading first means any hub
write after the read lands next sync. The price is that the sync after a push
re-reads the rows it pushed (they were stamped after that cursor read), so
**`pulled` counts rows the LWW upsert APPLIED, not rows received** - a
re-read of our own rows changes nothing and reports 0. Advancing `last_pull`
past the cursor to skip that re-read is NOT safe: another replica's push can
land between our pull and our push.

The upsert carries rows as ONE json parameter through `json_each` (D1 caps
bind params at ~100/query) and is guarded by
`WHERE excluded.updated_at > t.updated_at` - that clause IS the LWW rule.

Hubs implement one interface (`ensure_ready`, `schema_pull/push`,
`rows_pull/push/insert`, `cursor`): `LocalHub` (SQLite, used by tests) and
`HttpHub` (the service). Anything provider-specific lives behind it.

`POST /v1/rows/insert` is the atomic creation path. Existing IDs, including
tombstones, remain untouched regardless of initializer values. Only actual
committed `RETURNING id` receipts count as inserted or trigger derivations.
The response partitions submitted IDs into `inserted`, `existing` and
`rejected`; duplicate request IDs and history attachments fail before writes.
It shares table-write authorization and guarded catalog/invariant validation
with push. Never silently fall back to push on an unsupported hub. A lost
acknowledgment is safe to retry but does not preserve creation attribution.

**`HttpHub` must send a real `User-Agent`** - Cloudflare's edge bot
protection 403s the default `Python-urllib/x.y` agent (error 1010) before
the request reaches the Worker.

`soma watch` and `soma background run` push within ~1s of a local write
(fingerprinting the db AND its `-wal`, since WAL mode leaves the main file
untouched until checkpoint). Remote changes arrive through `RemoteChanges`, a
thread holding `GET /v1/changes?since=<seq>&wait=25` on the hub: any new
sequence (its first answer included) starts a round, and ends the loop's 1 s
tick at once (`RemoteChanges.wait`; the runner only while idle, since other
states ignore signals and a failed iteration may never take one). While that channel fails
the loops poll every `poll_seconds`; while it is live, `SAFETY_SECONDS` (600)
is the only timer. The hub bumps the sequence through `markChanged(tables)` from
`withChangeSignal`, which wraps every request and cron run: `commitChecked`
marks only a non-probe commit with transitions (so no-op, stale and rejected
pushes never wake replicas - a re-pushing replica would otherwise loop every
replica), and schema push (`_schema_log`), row creation, changeset commits and
purge hard deletes mark explicitly, each naming the tables it committed. A new
writer that bypasses those must call `markChanged(tables)` too;
a missed bump costs up to `SAFETY_SECONDS` (a held subscription poll, `MAX_WAIT`). Our own push echoes back one
quiet round. Both loops reset their file fingerprint after a round, which
also absorbs a local write made while it ran, so after a clean round
`pending_local_writes` (a dirty receipt, or a row stamped between the round's
snapshot and now) starts another round at once. The window ends at now, so a
row from a clock running ahead cannot keep rounds going.

UI clients hold the WebSocket form instead: `GET /v1/changes` with `Upgrade:
websocket` passes the same auth and table-read scope as the long poll, then the
Worker hands the upgrade to the object, which accepts it through the Hibernation
API. Native clients send their Bearer header; a browser cannot set headers on a
WebSocket, so it offers `soma-changes-v1` plus `soma-token.<token>` as
subprotocols and only `soma-changes-v1` is echoed. The object coalesces bumps
into one `{seq, tables}` message per 100 ms burst. Clients send `ping` and the
runtime answers `pong` without waking the object. A message costs no D1 round
trip, the object holds no per-device state and never retries: every client
opening (or reopening) a socket runs one full round, which covers anything
dropped. CORS never rewraps the 101 (a copied response loses its socket).

A quiet round stays cheap: `/v1/cursor` also returns `schema` (the hub's
newest `_schema_log` id) and blank marks for tables the hub lacks. A replica
whose own log has not moved since its last completed replay reads the cursor
first and skips `schema/pull` while `schema` has not moved either
(`_sync_state.schema_seen` = `<hub mark>:<local mark>`). A hub mark read after
a replay is never stored (another replica's DDL may land in between), so each
schema change costs two full-log rounds. Push candidates scan an unlogged
`<table>_updated_at` index each replica creates for itself, and pulled rows
commit per 200-row chunk so a `soma sql` writer never waits a whole pull.

## Hub service

`GET /v1/session` includes explicit protocol capabilities and uses no-store.
`tests/fixtures/hub-capabilities-contract.json` owns the response and the exact
403 `scoped_replica_unsupported` error for credentials without broad schema
access. Core enrollment requires advertised schema `full-ddl-v1` and
`replica_sync: true`; only entirely absent capabilities use the legacy full-token
default. Consumer enrollment still rejects operator/admin credentials. Capabilities
never broaden route scopes. The generated contract includes the wire types.
Subscriptions advertise `durable-pull-v1`; conditional row edits advertise
`conditional_patch: revision-v1`. Missing optional capabilities never authorize
falling back to an unconditional write.

Profile enrollment and projected reads are specified in `docs/scoped-enrollment.md`.
Optional service-owned `ENROLLMENT_PROFILES` holds named grant sets. Profiles
carry column, whole-table, broad `tables:read`/`tables:write`/`streams:append`,
named stream, capture, `rows:create` (current policy revision only), file-prefix,
`provenance:create:<table>` (beside `tables:write:<table>`) and
`subscriptions:consume` grants; never full, admin or token administration.
`docs/consumer-access.md` is the standard for which consumer uses which pattern.
Column patch grants require same-column and id/updated_at/hub_at reads, exclude
lifecycle fields, and never authorize push/insert or caller-supplied history.
The deploy workflow pushes `ENROLLMENT_PROFILES`, `ROW_CREATION_POLICIES` and
`CAPTURE_ADAPTERS` (JSON, `{}` when unused) from the project's ENV item on every
deploy; edit the item and redeploy, never `wrangler secret put` by hand. One Worker secret is
capped at 5.1 kB, so the deploy step sends `ENROLLMENT_PROFILES` as
`gzip:<base64>`; the Worker accepts either form and bounds decompression.
Requested unknown profiles never fall back to full. Auth storage binds
the approved profile revision and scopes to the fingerprint atomically. Profile
tokens get no governance authority. Core owns the optional profile expectation
and receipt DTOs and the pure `soma-core/enrollment` entry; hosts own JSC,
cryptography, HTTP, clocks and secure storage. Existing full enrollment remains
available without a profile. Projected reads authorize returned columns and
predicates before data access, require ID access and take a timestamp cursor
(`since`) only with the `hub_at` grant.

Exact `tables:read:<table>` / `tables:write:<table>` grants authorize canonical
body.table before data access. Narrow consumers use bounded direct rows APIs,
plus `/v1/cursor` and `{batch:[...]}` pulls for the tables they may read with an
arrival cursor (`authorizeCursor`/`authorizeRead`: a whole-table grant or a
`hub_at` column grant; marks only, no estate `schema` mark). Narrow reads fetch
the table check's first reads in one batch (`prefetchTables`), so a narrow
cursor, page or batch meets the replica read budget
(`worker/test/scoped-sync.test.js`). Global schema/catalog/stats/history/
provenance/internal/view/SQL routes stay denied. File grants remain independent. Narrow writes require a catalogued base
table with safe defaults and no generated expressions, arbitrary triggers,
derivations, ineligible enforced SQL rules or physical foreign keys. An enforced
table invariant is eligible when it matches one of the three anchored templates
in `scopes.js` (row pattern rejection, conditional JSON-tag membership,
same-table uniqueness), or when `confinedInvariant` finds that its SQL names no
other table, view or schema object in any quoting and has no `;` or comment.
It then runs unchanged in the checked transaction, so a rejection reveals
nothing outside the grant; a rule that fails to compile fails the request
closed. `provenance:create:<table>` (with `tables:write:<table>`) admits
insert-only `imported_from`/`evidence_of` edges onto live rows of that table
through `/v1/rows/insert` (`authorizeEdges`, then `edgePolicy` over
`scopedOrigin`), with canonical ids `<from_kind>:<from_ref>:<to_kind>:<to_ref>`;
the contract is in `docs/scoped-enrollment.md`. Column patches additionally admit the incoming single/multi-reference
deletion guards and derived tables when the patch touches no derived column or
derivation input (`patch.js` passes the patched columns to the policy). Their columns and ownership are checked; validation remains
transactional. `GET /v1/catalog/options?table=X&column=Y` exposes only static
select choices under the exact table-read grant, never dynamic SQL or other
catalog metadata. Eligibility reads join
the mutation's checked transaction; concurrent policy changes roll back. Narrow
writes require explicit string row IDs and deny any submitted row with an active
purge marker, including column markers. Markers on unrelated rows do not block
the write when the primary key is TEXT with BINARY comparison; other key forms
retain table-wide denial because distinct strings can alias one SQLite ID.
The marker lookup and table-existence check join the guarded read set,
so a concurrent marker also prevents commit. Narrow writes preserve all markers
and skip broad post-commit purge recovery. Validation errors are generic; internal references
are still checked server-side. The exact timestamp trigger is trusted by its SQL,
not its name. Broad callers retain their existing behavior.

`worker/src/creation.js` owns policy-bound `POST /v1/rows/create`. Service-owned
`ROW_CREATION_POLICIES` selects immutable app namespace, source identity shape,
target initializer columns and origin semantics; no consumer-specific values
belong in source. Only `rows:create:<policy-id>:<revision>` authorizes this
route, including for operator callers. Session capability `atomic-origin-v1`
is advertised only for current grants. New target and origin use two existing
checked writer plans in one transaction. Existing or tombstoned targets remain
unchanged; missing adopted targets fail closed. Creation grants confer no
governance authority. `scopedOrigin` is an internal, bounded provenance dependency
validator, never a general provenance grant. The canonical contract and limits
are in `docs/superpowers/specs/2026-10-06-create-only-origin.md`; portable consumer
types and strict checks export from `soma-core/creation`.
Python consumers import `soma.creation` from the pinned library package;
it needs no JavaScript engine. Shared wire fixtures and actual Worker response
tests keep its receipt/readiness checks aligned with the TypeScript boundary.
Neither entry point owns credentials, HTTP, scheduling or automatic retries.

`authenticate` in `worker/src/index.js` is the auth seam. It accepts the
operator `HUB_TOKEN` or a scoped token hashed in the separate `AUTH_DB`, and
returns a tenant handle used by the routes. The data D1 cannot alter the auth
registry. Browser approval uses the platform-provided Access identity and the
configured audience; it admits one owner to one dataset. API tokens and browser
Access sessions are separate authorities: revoking one does not revoke the other.
`auth.js` records opaque governance principals separately from token names and
scopes. Verified browser enrollment can establish user approval authority;
operator-created tokens receive agent proposal authority only. Legacy tokens
without that record remain ineligible; no name or full/admin scope substitutes
for it. Authority revocation and token revocation are checked on each request.
Exact governance preview routes bypass auth last-use writes, initialization and
the usage flush while still authenticating and reading the current cap. Cold or
unready service state is unavailable. The protocol remains unadvertised until
all documented operations and writer guarantees exist.

Backups (`worker/src/backup.js`): the cron exports each database in the
`BACKUP_DATABASES` var (`soma` = DB, `auth` = AUTH_DB) through D1's export
API, polling with the returned bookmark until the signed URL appears, and
streams that SQL file through gzip into one R2 multipart upload per retention
prefix today qualifies for (`<prefix>/<name>-<stamp>.sql.gz`, 8 MiB parts),
aborting every upload on any error so no truncated copy lands. **Never dump
with SELECTs**: once one table's result outgrows D1's response limit the
whole run fails (`D1_ERROR: Memory limit exceeded before EOF`). A running
export blocks other queries on its database (about 30 s for the 600 MB data
dump); a whole run takes about 36 s wall and under 1 s CPU. `BACKUP_API_TOKEN` is a
Cloudflare token with D1 Write only (the export endpoint refuses D1 Read; D1
grants are account-wide, Cloudflare has no per-database scope), minted by
`scripts/provision.py` into the ENV item and pushed on deploy. The cron awaits
the backup, so a failure fails the run in Cloudflare's cron history; it also
posts `backup.failed` (critical) into the notification feed, and the first
success after a failure, or after a newest daily copy older than 26 h, posts
`backup.recovered`. `POST /v1/backup` (full/admin) runs the same path on demand.
Restoring into D1 goes through `scripts/d1-fit-dump.py` (tested by
`tests/test_d1_fit_dump.py`): the export writes rows over D1's 100 KB statement
limit as single INSERTs, which `wrangler d1 execute --file` refuses
(`SQLITE_TOOBIG`). Local sqlite3 restores need one wrapping transaction.
Each stored copy gets an empty `<key>.sha256` sidecar holding its digest as
metadata. Consumers use `/v1/backups` (`docs/backups.md`): `backups:read` lists
and downloads the data database's copies, `backups:write` takes an hourly-limited
`manual/` copy; `full`/admin imply both, table grants never do.

Two cron triggers, dispatched in `scheduled()` on `event.cron`: `10 9 * * *`
is the backup, `*/15 * * * *` is the derivation sweep (`SWEEP_CRON` in
`index.js` must match `wrangler.jsonc`).

Derivations (`worker/src/derive.js`). `derived_by = "http:<name>"` resolves
ONLY through the `DERIVATIONS` Worker secret - a JSON object
`{name: {url, headers, refresh_days?, no_data_refresh_days?}}`. **No external
source may be named in `worker/src`.**
The hub POSTs `{tbl, id, inputs:{col: value}}` and writes back the response
keys that are derived columns of that derivation (plus `_source_ref`);
anything else is ignored. A 2xx object is a completed lookup: each derived
column it omits gets a no-data proof (`detail` `{"no_data":true}`, `value_hash`
of the value left in place, which is never cleared), so a no-match stops being
retried every sweep. No-data proofs refresh after `no_data_refresh_days`
(default 7), ordinary proofs after `refresh_days` (default never); the sweep's
per-table limit bounds the refresh volume. Output runs through `validateRow` first - a value
failing its type/options/pattern is dropped and reported in `failed`, its
siblings still land. A write is ONE guarded `db.batch`: provenance, value UPDATE, enforced
invariants and actual cell history commit together. Reads captured before the
external request prevent a concurrent edit from receiving stale output.
Runs three ways: after `/v1/rows/push`, `/v1/rows/patch` or actual `/v1/rows/insert` creations via `ctx.waitUntil` (never delays the
response; a failure is retried by the sweep; freshness is judged on the complete stored rows, never the sparse payload), on the 15-minute sweep
(underived or `inputs_hash`-stale, 50 rows per table), and synchronously via
`POST /v1/derive {table, ids, col?}` (>50 ids → 400). Routes take
`(body, db, env, ctx)` and may return a `Response` of their own. `soma derive
<tbl>.<col> [--where <sql>]` is a client-side wrapper around that route: it
selects ids locally, calls `/v1/derive` in chunks of 50, and reports totals -
it never computes a derived value itself. Requires a hub token with
`tables:write` (or `full`/admin).

Derivations run in dependency order (one whose inputs include another's outputs
runs after it; a cycle keeps catalog order), and after a commit the touched rows
are judged afresh for the derivations reading its outputs. A candidate is a row
whose `updated_at` is at or past a proof's `produced_at` (inclusive: same-millisecond
edits count); hashes decide freshness. The sweep pages candidates in id order and re-hashes them, passing rows found
fresh; each table resumes after the id stored in `_derivation_cursors` (hub-owned
operational state like the cooldowns), held back at the first row left
unattempted (budget, limit, cooldown), so no row hides the rows after it. Each
table gets an equal share of what is left of the budget, at most half of it for
scanning, so one table's backlog cannot starve the tables after it. A scan that runs out of its share,
and rows past a call's limit or budget, are reported in `failed`, never dropped.

Manual record Resolve uses `POST /v1/derive/resolve` with exactly one `ids`
entry, `col` and required `expectedUpdatedAt`. The separate route makes older
hubs fail closed. It shares broad table-write authorization; narrow table/column
writers cannot invoke external derivations. The displayed row revision must
match the guarded provider snapshot before HTTP; existing read guards reject
provider-time changes. Core `resolveDerived` requires a bound replica, a live
saved derived property and matching local/hub revisions, and never writes local
values from its receipt. Hosts retain drafts, sync normally and re-read the row.

Endpoint requests have a 60-second abort timeout. Non-2xx failures retain
`id`, `col`, `error` and integer `status`. Diagnostics use only sanitized
string `JSON.error` from bodies up to 16 KiB, capped at 512 characters;
URLs, credentials, headers and HTML are omitted or redacted. Values,
provenance and history remain unchanged on endpoint failures.
Safe source-prefixed error text is preserved. Transport failures retain
`TimeoutError`/`timeout` or `unreachable` during fetch and body consumption
so callers can classify outages; only JSON syntax errors are invalid JSON.
Redaction includes full configured headers and authentication components
(a Basic credential's decoded user and password too), plus URL userinfo and
query values in raw and decoded forms.
429 and 503 `Retry-After` values accept integer seconds or an HTTP date;
returned `retry_after` is a positive integer (at least one second). Missing
or invalid 429 hints default to 60 seconds; 503 without a valid hint has no
cooldown. `_derivation_cooldowns` is hub-owned operational D1 state keyed
by the SHA-256 of `[endpoint name, URL]`, independent of header rotation.
Every caller checks it before fetching and reports deferred failures with
remaining seconds. Concurrent hints cannot shorten an existing cooldown;
expired rows are reusable. Create this internal table before taking schema
read guards. Its DDL is never logged for sync and it has no catalog rows;
full operational backups retain it. Existing calls and sweeps retry after
expiry, with no additional schedule or automatic retry loop.

## Usage meter, cap and notifications

`worker/src/usage.js` wraps the hub (`main.js` is the deployed entry). It
reports this deployment's own consumption only, never the provider account's.

- **Metering.** One stable wrapper per D1 binding adds every result's
  `meta.rows_read`/`rows_written`/`size_after` to the meter of the request it
  runs in, found through AsyncLocalStorage (`nodejs_als` flag), including
  `ctx.waitUntil` work. Stable wrappers keep identity caches such as
  `ensureHubAtIndexes` hitting; a per-request wrapper would rerun them. The
  wrapper's `first()` runs `all()` (D1's own `first()` runs the whole
  statement and drops meta); `raw()` reports no meta. After the response and
  its waitUntil work settle, one AUTH_DB batch adds the request to
  `_usage (period, principal)`: principal = token name, `admin`,
  `system:sweep`/`system:backup` or `anonymous`. `authenticate` is resolved
  once per request, shared by the meter and the hub.
- **Limits.** Defaults are the provider's included monthly amounts (D1 reads
  25B, writes 50M, requests 10M, storage 5 GB). `USAGE_LIMITS` (JSON, per
  metric `{allowance, cap, alert_at}`) and `USAGE_PERIOD_ANCHOR_DAY` (1-28,
  default 1) override them. Requests never cap: a refused request still bills.
- **Notifications.** Producers: `usage` (below) and `backup` (`backup.failed`,
  `backup.recovered`, see Hub service). The flush that crosses an `alert_at`
  fraction or a cap inserts into `_notifications` (AUTH_DB) at that moment. The id
  (`usage:<period-start-date>:<metric>:<pct|cap>`) is the dedupe key, so
  concurrent isolates insert once and a future push reuses the same id.
  Read state is deployment-wide.
- **Cap.** At a D1 metric's cap every authenticated `/v1` route answers 429
  `usage_cap` with `Retry-After` until the period resets (usage numbers in the
  body only for tokens that may read `/v1/usage`), except the ones that
  never read the data D1 (`UNCAPPED_ROUTE`: usage, notifications, session,
  tokens, files, streams, archive). Deny by default: a new D1 route is capped
  unless listed, and the cap is not gated on the route's scope check, so a
  finer-grained grant cannot bypass it. The sweep cron is skipped; the backup
  still runs. Each isolate rereads period totals every 30 s and after its own
  flushes. `withUsage` wraps `fetch` and `scheduled` and passes any other
  handler through unmetered; wrap a new handler (queue, ...) there, and name
  a new cron's principal there (any non-sweep cron is `system:backup` today).
- **Endpoints.** `GET /v1/usage` and `GET /v1/notifications?after=<seq>&limit=<1-200>`
  need `full`, `tables:read` or admin; `POST /v1/notifications/read`
  `{ids:[...]}` or `{through: seq}` needs `full`/admin and returns the unread
  count. The feed is ascending by `seq`; `next_cursor` is set while more pages
  remain; `latest_cursor` is the newest seq, which a new device stores as its
  baseline before presenting native alerts. Shapes:
  `tests/fixtures/hub-usage-contract.json`, asserted by `worker/test/usage.test.js`.
- **CORS.** For a `CORS_ORIGINS` origin the wrapper answers these routes'
  preflight before authentication and the cap (per-route methods; headers
  Authorization, Content-Type, If-None-Match), and its responses, including
  the 429, expose `Retry-After`. Other routes' preflight goes to the hub.

## Streams

Append-only events, hub-backed by design (tables are local-first; streams are
not - the events are born remote). `POST /v1/streams/<name>/append` stores the
request body VERBATIM as a time-prefixed landing object (raw is sacred, never
deleted - everything downstream is rebuildable from landing) plus a
`state/<stream>/latest.json` pointer for O(1) tail, then tees
`{stream, ingested_at, record}` into the Pipelines stream binding (`EVENTS`).
The tee must NEVER fail the append - landing is the source of truth.

Exact `streams:append:<name>` and `streams:read:<name>` grants are independent.
Append grants authorize only append; read grants authorize tail and bounded
`records` pages, never manifest, arbitrary files, SQL, tables, batch or replay.
`docs/scoped-streams.md` defines cursor and byte limits. Separate landing pages
are not source-time incrementals, a snapshot or per-person latest state.

Managed platform (all open beta, Workers Paid): Pipelines stream
`soma_events` (explicit schema: stream string, ingested_at string, record
json) → pipeline `soma_pipeline` (SQL passthrough) → Iceberg sink →
table `soma.events` in the R2 Data Catalog on `soma-archive`, managed
compaction enabled. `POST /v1/archive/query` proxies SQL to R2 SQL
(`api.sql.cloudflarestorage.com/api/v1/accounts/<acct>/r2-sql/query/<bucket>`)
with the Worker's `R2_SQL_TOKEN` secret - clients never hold a provider
token. Table columns: `stream`, `ingested_at`, `record` (JSON string),
`__ingest_ts`. `WHERE`/`count(*)` work; `record` needs client-side JSON
parsing or the `--raw` DuckDB path for field-level analytics.

Beta gotchas, all hit at build time (2026-09-02):
- **Creation order is load-bearing**: stream WITH explicit schema first,
  THEN sink, THEN pipeline. The sink creates the Iceberg table at sink
  creation with whatever shape it can see - created against a schema-less
  stream you get a useless `value` JSON-string column, and "writing to
  existing Catalog tables is not yet supported" blocks fixing it without
  dropping the table (Iceberg REST: get `prefix` from
  `catalog.cloudflarestorage.com/<acct>/<bucket>/v1/config`, then DELETE
  `/v1/<prefix>/namespaces/soma/tables/events?purgeRequested=true`).
- Schema-less streams declare ONE required `value` field: events sent as
  `{stream, ...}` fail validation SILENTLY (binding send still succeeds).
- The wrangler `pipelines` binding wants the stream **ID**, not name; the
  ID changes when the stream is recreated - update wrangler.jsonc + deploy.
- Sinks with auto-created R2 credentials derive them from the token used at
  creation: deleting that API token strands the sink ("authentication
  failed", pipeline → failed state). Recreate sink + pipeline.
- Rebuilding the table (a recreated sink or catalog) = replay each landing object
  through `POST /v1/streams/<name>/replay?ingested_at=<the time in its key>`; the
  route tees without writing landing and keeps that original ingest time.
- The stream BUFFERS across sink failures/recreation - buffered events
  redeliver once a working sink exists. Landing remains the true raw record.
- **Delivery into `soma.events` is AT-LEAST-ONCE and eventually consistent**:
  a send can land in the table minutes later and can be duplicated by
  redelivery (a 23-record replay once materialized as 46 rows). Never
  "verify" a tee by querying the table right away, and never re-send/replay
  because the count looks short - check the landing manifest instead (landing
  is exactly-once), wait out the sink roll, and treat residual projection
  duplicates as a query-time concern (dedupe on a record-level key).
- `EVENTS.send` can stall past 30s while still succeeding - the client's
  default timeout is 120s for this reason. A client-side timeout on
  append/batch does NOT mean the write failed: check the manifest before any
  retry (retrying a landed batch duplicates both landing and events).

Credentials have separate owners:
- Consumer devices enroll through `soma login` and store their app-issued
  tokens in native Keychain. Never distribute operator/provider tokens to them.
- Services enroll with a named profile (`docs/consumer-access.md`, pattern A)
  and keep the token in their own project's secrets. The auth registry stores
  only hashes in `AUTH_DB`. Revocation is per credential; `full` allows data
  operations, not token administration.
- `HUB_TOKEN` is an independently managed operator credential. It is never an
  implicit fallback for a signed-out consumer session.
- Cloudflare infrastructure credentials belong to the service and its CI/operator
  tooling. Provider IDs and credentials never enter client configuration.
- Pipeline sink storage credentials may derive from a provisioning token. Check
  that dependency before rotating it; routine app sign-in needs no provider key.

## Bounded consumer queries

`worker/src/rows-query.js` owns `/v1/rows/query`, advertised as
`row_query: bounded-v1`. The pure `soma-core/query` entry owns request validation.
Projected, predicate and sort columns require read grants. Cursors bind request,
schema/catalog shape and profile revision, with native SQLite collation and
null-last ordering. Text identities and safe scalar sort values are supported.
Pages are separate reads, never snapshot or full-catalog coverage. Runtime
schemas own query indexes; no consumer table names belong in service code.

## Consumer configuration

`worker/src/consumer-config.js` serves profile-bound configuration at
`GET /v1/consumer/config` and column-authorized static metadata at
`POST /v1/catalog/projection`. Config is installation-owned state inside
`ENROLLMENT_PROFILES`, included in the canonical profile revision. Changed
bindings require reenrollment; config-less legacy hashes remain stable.
Canonical config checks export from `soma-core/consumer-config`; generated
Swift/TypeScript DTOs come from `core/contract/core.json`. Profiles admit up to
256 distinct grants. Metadata grants require matching row read grants;
projection never executes or discloses dynamic option SQL. These endpoints
confer no replica, arbitrary SQL or general catalog authority.

## File service

`PUT/GET/HEAD /v1/files/<key>` serves retained originals through the hub's
ARCHIVE binding. Prefix scopes `files:read:<prefix>/` and
`files:write:<prefix>/` are independent and match canonical decoded keys.
The same checks protect the legacy `/v1/archive/<key>` read route;
`tables:read` never grants object access. Full/admin retain archive access.
Reject encoded separators, double encoding, dot/empty segments and control
characters before touching storage. Conditional PUT uses `If-None-Match: *` and required lowercase hex
`X-Content-SHA256`; the storage service validates the streamed bytes atomically.
201 returns key/mime/bytes/sha256/etag. Existing keys return 412; retries reconcile
through independently authorized HEAD metadata. Unconditional legacy writes remain
compatible; unchecked legacy objects have no SHA-256. Every object response is
attachment + nosniff + sandbox/default-src-none CSP, regardless of MIME.
Canonical shapes: `tests/fixtures/hub-files-contract.json`.
Tests exercise real token creation,
revocation and requests against an in-memory archive.

`GET /v1/files?prefix=&cursor=&limit=` lists `{objects:[{key,size,uploaded,etag}],cursor}`
(limit 1-1000, default 100; opaque cursor, `null` on the last page). A
`files:read:<prefix>/` holder lists only inside its prefix; full/admin list the
whole archive. `soma files list <prefix>` follows every page.

`DELETE /v1/files/<key>` is full/admin only (no file grant reaches it; the
legacy archive route has no delete), returns `{key,bytes,etag}` or 404, refuses
`__r2_data_catalog/` keys without `?catalog=1` and accepts no other parameter.
Each delete writes a `files`/`file.deleted` notification naming the token.
`soma files rm <key> --yes [--catalog]` wraps it.

`POST /v1/files/rehome {from,to}` is HUB_TOKEN-admin only (full tokens get 403):
it moves an object whose stored key fails the canonical key rules (`from` is the
raw stored key) to a canonical, not-yet-existing `to`, verifies size and etag
before deleting `from`, and logs `file.rehomed`. A multipart original's etag
never matches the copy, so such an object fails closed with 502.

File-consumer registry (every file consumer and prefix is listed here, per
`docs/consumer-access.md`). Consumers depend on this supported service contract
only; each keeps its operational recovery state in its own store, and Soma
storage credentials never leave this service.

| Consumer | Prefixes |
|---|---|
| Flighty Sync | `raw/flighty/` |
| Page Archiver | `captures/pages/` |
| Screentime Dashboard | `raw/screentime/` |
| Music Sync | `raw/spotify-pull/`, `raw/spotify-capture/` |
| People Sync | `photos/people/`, `photos/records/`, `profiles/` |
| Circle (profile `circle-reader`, read only) | `photos/people/`, `photos/records/` |
| Media Center YouTube offline (mini job) | `youtube/` |
| Strava Sync | `raw/strava/` |
| Synapse | `raw/synapse-executions/` |

Consumer registry (one credential per caller, per `docs/consumer-access.md`).
Profiles live in the ENV item's `ENROLLMENT_PROFILES`; tokens live where the
consumer reads them, never in this repo.

| Consumer | Credential | Held in |
|---|---|---|
| Networth | profile `networth-reader-v2` (broad `tables:read`: it reads `provenance` slices) | Networth ENV `SOMA_HUB_TOKEN` (Worker secret) |
| Task Burndown | profile `task-burndown-reader-v1` (projected tasks/projects reads incl. `hub_at` for cursor pulls), enrolled headless with `soma login --profile ... --start/--claim` | Task Burndown ENV `SOMA_HUB_TOKEN` (Worker secret) |
| Bookmarks Sync | profile `bookmarks-sync-writer-v1` | Bookmarks Sync ENV `SOMA_HUB_TOKEN` (Worker secret) |
| Media Center poller | profile `media-center-poller-v1` (broad read/write: it inserts `provenance`) | Media Center ENV `SOMA_HUB_TOKEN` (Modal secret) |
| Media Center apps | profile `media-center`, one enrollment per device | device Keychain |
| Music Sync | profile `music-sync-writer-v1` (broad read/write: catalog, derive, `provenance`) | Music Sync ENV `SOMA_HUB_TOKEN` (Modal secret) |
| Screentime Dashboard | profile `screentime-dashboard-archive-v1` | Screentime Dashboard ENV `SOMA_HUB_TOKEN` (Worker secret) |
| Synapse | profile `synapse-workspace-v1` (broad read/write: narrow writes are refused on its capture tables) | `synapse-state` workspace `default`, copy in Synapse ENV `SOMA_HUB_TOKEN` |
| Reflex | profile `reflex-v2` | Reflex ENV |
| Birthdays, Circle, Strava Sync | profiles `birthdays-reader-v1`, `birthdays-editor-v1`, `circle-reader`, `strava-sync-v1` | each app's own storage |
| Flighty Sync, Page Archiver, Shared Album Reminders, Media Center YouTube offline, Bookmark Mirror, Birthdays task writer, Calendar Feeds, OwnTracks phone, People Sync files | pattern C exact operator tokens (`flighty-sync`, Page Archiver's, `shared-album-reminders-mini-v2`, `media-center-youtube-offline`, `bookmark-mirror-macbook`, `birthdays-task-writer`, `calendar-feeds-*` (minted by its `scripts/provision.py`), `phone`, `people-sync-files`); each moves to a profile at its next rotation | each consumer's native secure storage or settings |
| soma CLI replicas (one per Mac), Iris (one per device) | browser device enrollment (`soma login`), `full` | device Keychain |
| People Sync communication import | operator token `people-sync-comm` (`full`: `/batch` and `archive query` admit only `full`) | People Sync operator env |
| Find My friend-location collector | exact operator token `friend-location-collector` (`streams:append:friend_city_checks`) | the mini's login Keychain |

## Durable change recording

`worker/src/subscriptions.js` owns private `_change_subscriptions` and
`_change_events` state. Activation installs exact per-source triggers atomically;
`subscription-triggers.js` generates and recognizes their SQL. Selected actual
OLD/NEW values, source revisions and per-subscription sequences commit with each
mutation, including derivations and hard deletion. Timestamp/noop/stale/rejected
writes create no event. Paused subscriptions keep recording; retired ones stop.
Capacity and per-event size failures roll back the source mutation. Canonical
shapes and bounds live in `tests/fixtures/hub-subscriptions-contract.json`.
Selected columns support TEXT, INTEGER and REAL, preserving numeric JSON values.
Per-source `lifecycle: true` records live insertion/deletion/restoration even with
empty changes; restoration is `restore`. Default subscriptions retain value-only
events and `update` on restore. New trigger sources carry version 3, whose change
list uses `json_each` instead of one compound-SELECT term per column (D1 allows five),
so a source may select up to 16 columns. Version 2 and missing version regenerate
their persisted SQL exactly. Never reinterpret persisted trigger definitions. `subscription_features: scalar-lifecycle-v1` advertises the extension.
Activation rejects custom source/outbox triggers; only complete canonical timestamp
statements (quoted or unquoted CLI identifiers) and exact generated recording
triggers are supported. Timestamp revisions use the same
statement-stable SQLite clock as the canonical timestamp trigger. Physical cleanup
of tombstones emits no second logical delete. Narrow writes reject triggers on
implicit outbox destination tables inside their checked policy read set.
Schema replay permits plain nullable TEXT/INTEGER/REAL/BLOB column additions on
watched source tables, preserving existing columns and the entire source/outbox
trigger set. Rowid aliases and `hub_at` additions remain protected because they
change revision semantics. Other structural changes require retiring affected subscriptions. Private operational
DDL never enters the replica schema log or catalog. `durable-pull-v1` delivers persisted offered batches through capped long polls
and explicit ACK receipts. A held poll reads `ChangeSignal`'s seq, then D1, then
waits on the object (`table` params: its source tables) for a commit naming one;
it re-checks D1 only on that wake, every `MAX_WAIT` and at the deadline, so an
idle poll costs a constant few statements. The object keeps each table's last seq
in memory only: an older seq or a bump naming no table counts as a change.
Without the binding, or once a wait fails, the poll re-reads D1 every second. Consumers need the subscription grant plus read access
to every source. Live auth is rechecked before release; GET never advances ACK.
Empty retired subscriptions honor the requested wait. Admin selects immutable
sources at creation and can pause/resume or permanently retire recording.

## Capture service interface

`worker/src/capture-gateway.js` is a stateless supported consumer API. Synapse
owns the media resolver, category/field restrictions, durable receipts and
serialized writes. Soma holds its own independently minted Synapse gateway
credential in `CAPTURE_ADAPTERS`, never in a native client. Consumers hold only
their scoped Soma session. The gateway delegates an opaque credential-bound
subject; receipt namespaces belong to gateway-client plus subject plus UUID.
Replacing either credential changes that receipt namespace. Revoking the gateway
stops captures but leaves ordinary catalog reads and edits available. Deploying
Media Center's poller or native clients does not mutate service infrastructure.
The contract and bounds are in `docs/scoped-enrollment.md`; portable fixtures
are in `tests/fixtures/hub-capture-contract.json`. No adapter is enabled by source
alone. The pure receipt/capability policy is `core/src/capture.ts`.
Upstream calls use `redirect: 'manual'`: Workers reject `'error'`, and Bun-based
tests would not notice. Submissions get 60 s because acceptance waits for the
adapter's serialized writer; receipt reads get 15 s.

Profile consumers: Media Center's native iPhone/Mac clients enroll with profile
`media-center` (consumer config namespace `media-center`; table/column bindings
and grants are ENV state) and capture through adapter `media` (Synapse's media
endpoint). The adapter's gateway credential is minted by Synapse's
`scripts/media-capture.py`; its `CAPTURE_ADAPTERS` value is kept in the ENV item.

Singleton creation policies can use `occurrenceType: "none"` and the generic
`prefix-source-v1` identity encoding. Such requests omit `occurrenceKey`;
recurring policy encodings and revisions remain unchanged. Prefixes and
source registries are deployment state, never consumer-specific constants.


Transferable extension queries use canonical `prepareReadPlan` and the same view
compiler. Emit typed calendar slots at binding sites, never infer them from values
or SQL text. Exact ordered schema/catalog/view/hub guard rows must be checked by
read-only consumers in the query transaction; host workspace/replica identity,
coherent publication, policy, work budget and stale presentation remain mandatory.
Plans reject nonempty FTS; list/count limits are 20/10,001 respectively.
## Apple push

`worker/src/apple-push.js` owns optional native registration and APNs delivery.
The three exact auth-store registration routes are usage-cap exempt. Native
authority comes from explicit Access-verified app-profile approval, never token
names or caller-supplied principals. Revisions guard rotation and revocation;
opaque session/installation bindings never expose token hashes. Push acceptance,
OS presentation and shared read state remain separate. Deployment/event identity
uses the 43-byte base64url SHA-256 JSON tuple in `docs/apple-push.md`; delivery
receipts also bind the installation. Configure the dedicated provider key and
profiles through the owning project's service ENV, never client settings.
A hub change also wakes closed and backgrounded apps: `ChangeSignal` sends one
silent push (`apns-push-type: background`, priority 5, body
`{"aps":{"content-available":1},"somaSync":1}`) to every active installation
through `deliverBackgroundPush`. The first change after a quiet gap sends at
once; later changes share one trailing push when the 20-minute gap ends (a DO
alarm), the most Apple delivers without throttling. No feed event, receipt or
retry: the app's next round covers a lost push.

Transient UI definitions are validated by `resolveViewDefinition` through the saved-view compiler. This read operation copies finite JSON before awaiting catalog/schema reads and never provisions views or writes saved configuration, history or pending edits. Hosts supply current calendar bounds and keep stored action revisions separate from ephemeral display/query configuration.
