# Scoped stream access

Exact grants keep producer and reader credentials independent:
`streams:append:<name>` permits `POST /v1/streams/<name>/append` and
`POST /v1/streams/<name>/batch` (1..1000 records, at most 1,000,000 UTF-8 body
bytes, preserving the live tail);
`streams:read:<name>` permits only `GET .../tail` and `GET .../records`.
Names use the existing literal stream-name grammar. Neither grant permits
replay, manifest, arbitrary files, SQL, tables or token management. Read-only
grants never authorize append or batch import.
Exact-producer batches require valid UTF-8 JSON. Malformed bytes or JSON return
400 before storage or pipeline writes; oversized bodies return 413.
Full/admin imports retain their existing record-count-only body contract.
Existing broad grants retain their existing behavior.

Service-owned enrollment profiles may contain exact stream grants. Browser
approval and native enrollment policy validate and preserve the exact grant set;
no profile is installed or credential minted by enabling the protocol. Existing
column-only profile revisions stay unchanged.

`GET /v1/streams/<name>/records?limit=20&cursor=<opaque>` returns
`{entries: [{id, body}], next_cursor}`. IDs are stable opaque landing identities;
body is the original UTF-8 text, including arrays from historical batch imports.
Limit is 1..20 (default 20), with at most 2,000,000 UTF-8 response bytes.
An oversized page fails wholly with 413; retry with a smaller limit. An oversized
single object remains unavailable through this bounded interface. Invalid UTF-8, missing objects
or storage failures fail the page wholly. Cursor binds the stream and protocol.

Pages walk retained landing objects in storage order. Separate pages are not an
atomic snapshot, certified coverage, per-person latest state or a source-time
incremental cursor. Readers validate their own record contract and reconcile
whole scans. A later append may sort behind a previous page under clock skew;
never infer permanent absence from a completed walk. Collection/ingestion time
does not establish observation freshness. Tail remains one latest append body
for the entire stream. Source-specific reducers and policies belong to consumers.

## Implementation plan

- [x] Exercise real authenticated routes with independent read/append tokens;
  pin forbidden operations, adjacent names, malformed paths and revocation.
- [x] Add exact grants in the existing authorization seam and bounded landing
  reads in the existing stream handler, with no new storage or dependencies.
- [x] Test original bytes, multi-page walks, cursor binding, size limits,
  missing objects and short/truncated storage pages; mutation-check isolation.
- [x] Run existing Worker/core/Python checks, review the diff and commit the
  feature branch. Deployment, enrollment profiles and minting are separate.
