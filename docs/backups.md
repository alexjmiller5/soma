# Backups, export and restore

## Hub backups

The backup cron writes gzip SQL exports of each `BACKUP_DATABASES` entry into
retention prefixes (`daily/`, `weekly/`, `monthly/`, `yearly/`;
`scripts/cf-r2-lifecycle.py` owns the expiries). Consumers see only the data
database's copies, the first `BACKUP_DATABASES` entry; the auth registry's
copies are never listed or served.

| Route | Grant | Result |
|---|---|---|
| `GET /v1/backups` | `backups:read` | `{backups:[{key, taken_at, bytes, sha256}]}`, newest first |
| `GET /v1/backups/<key>` | `backups:read` | the stored gzip bytes, `Content-Type: application/gzip`, attachment |
| `POST /v1/backups` | `backups:write` | 201 `{backup:{key, taken_at, bytes, sha256}}` under `manual/` |

- `full` and `admin` imply both grants; `tables:*` grants never do. Enrollment
  profiles may carry `backups:read` and `backups:write`.
- `key` is `<tier>/<name>-<YYYY-MM-DDTHH-MM-SS>.sql.gz`; any other key is 404.
- `sha256` is the hex digest of the stored gzip bytes, kept in an empty
  `<key>.sha256` sidecar's metadata (multipart objects carry no checksum).
  Copies stored before sidecars existed report `null`.
- `POST` exports the data database through D1's export API, which blocks the
  database for its duration, so it is limited to one manual copy per hour:
  429 `{error:"backup_rate_limited", retry_after}` with `Retry-After`. It is
  subject to the usage cap; listing and downloading are not.
- Clients verify downloads against `sha256` and gzip's own CRC.

## Dump format

One SQL text shape, version 1, from three producers: `soma export`, the hub's
D1 exports and soma-core's `exportReplica`. A first line
`-- soma-dump: <version>` names the version; a dump without it is
version 1. `soma export` and `exportReplica` write
`BEGIN TRANSACTION;`, each table's `CREATE TABLE` followed by its
`INSERT INTO ... VALUES(...)` rows, then indexes, triggers and views, then
`COMMIT;`. D1 exports have no transaction lines and spell newlines as
`replace('a\nb','\n',char(10))`. Any of them imports into a fresh database
with `sqlite3 <dir>/soma.db < dump.sql`, which `SOMA_DATA_DIR=<dir> soma ...`
then reads.

`exportReplica` writes the schema log and every ordinary table; device sync
state, caches and other underscore plumbing stay out.

## Restore (soma-core)

Hosts pass opaque file references; a `BackupFiles` adapter opens them as text
(removing and checking gzip) and creates destinations that become durable on
`close()`.

- `validateBackup` reads the whole dump without touching the replica. Only
  the statement shapes above are accepted; values are literals (`NULL`,
  numbers, strings, `X'..'` blobs, `replace(...)`/`char(...)` of literals).
  It refuses a newer format version, a missing or different
  `_schema_log (id, applied_at, ddl)`, rows for undeclared tables or columns,
  a `BEGIN` without its `COMMIT`, statements after `COMMIT` and a truncated
  final statement. It returns tables with row counts, live (not deleted) rows
  and newest `updated_at`.
- `previewRestore` adds the same summary of the current replica.
- `restoreReplica` requires `confirm: "replace"` and a separate recovery
  destination. It validates the backup, writes the recovery dump of the
  current replica, then in one transaction drops every ordinary table and
  view, recreates them from the dump with core-built inserts (never the
  dump's own SQL for rows), restores the schema log, and resets device sync
  state. An interrupted or failed restore rolls back to the old replica. The
  next sync pulls everything and pushes every restored row: newer hub
  revisions still win, rows the hub lacks reach it. Undo is a restore of the
  recovery dump. Files synced by the Python CLI are refused; restore those
  with the CLI.
