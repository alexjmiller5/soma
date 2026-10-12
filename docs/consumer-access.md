# Consumer access

How anything other than the owner's own `soma` CLI and Iris reaches a Soma
Data hub. The grant grammar and the enrollment protocol are in
[scoped-enrollment.md](scoped-enrollment.md); this is the policy for using them.

## Rules

- **One credential per (caller, service) pair.** Each consumer holds a Soma
  Data token minted for it alone. Never share, copy or reuse a token across
  consumers, projects or machines.
- **The consumer's project owns its credential.** A server stores it in its own
  project's secret store (for a project with a `<Project> ENV` secrets item, the
  field `SOMA_HUB_TOKEN`). A device or UI keeps it in its own secure storage.
- **Revocation touches one caller.** Revoke an enrolled credential at
  `<hub>/login/devices`, an operator-minted one with `soma token revoke <name>`.
  No other consumer is affected.
- **The narrowest grants that work.** Column or whole-table grants before broad
  ones, a file prefix of its own, named streams before broad `streams:append`.
- **Consumers hold only a hub URL and their own token**, never the operator
  `HUB_TOKEN`, provider credentials or the hub's database and bucket bindings.

## Pattern A: link approval with a named profile (default)

For devices, UIs and servers. The hub operator defines the grant set once as a
profile in the service configuration `ENROLLMENT_PROFILES`
(`{"<id>": {"label": "<App>", "scopes": [...]}}`, id `[a-z][a-z0-9-]{0,63}`,
conventionally `<app>-v<n>`), then deploys. The owner approves each enrollment
in the browser, seeing the application label and every grant.

- A device or UI runs its own enrollment with the profile (soma-core
  `enrollmentApproval({fingerprint, name, profile})`, or
  `soma login --profile <id>` on a Mac).
- A server is enrolled by its operator in two steps:

  ```bash
  soma login --profile <id> --name "<Project> server" --start pending.json
  # send the printed approval_url to the owner, who approves it
  soma login --claim pending.json --wait   # prints only the token, deletes pending.json
  ```

  Pipe the claimed token straight into the project's secret store
  (`SOMA_HUB_TOKEN`), never into a file in a repo, an argument or shell history.

Changing a profile's grants changes its revision. Existing credentials keep the
grants they were approved with: enroll a new credential under the new revision,
switch the consumer to it, then revoke the old one.

## Pattern B: full-device link approval

Only for the owner's own `soma` CLI (`soma login`) and Iris. A full device
credential replicates the whole estate and can approve governance proposals, so
it never goes to an application or a server.

## Pattern C: operator-minted exact token

`soma token create <name> --scopes <grants>` with the operator credential, only
for a grant the hub cannot put in a profile. Every consumer grant is
profileable: `full` is pattern B, and token administration exists only as the
operator `HUB_TOKEN`, which no consumer holds. Pattern C therefore has no
consumer use; an existing operator-minted consumer token moves to pattern A at
its next rotation. Until then an exact token held in the consumer's own secure
storage conforms; the deployment's consumer registry lists each one.

## File-prefix registry

Every file consumer and each prefix it reads or writes is listed in the
deployment's file-consumer registry (`AGENTS.md`, File service). A new file
consumer takes an unused prefix and adds its registry row in the same change
that adds its profile. Prefixes do not overlap between writers. Retained files
are listed with `GET /v1/files?prefix=` or `soma files list <prefix>`.

## Reading a table repeatedly

A consumer that reads the same tables on a schedule or per request and keeps no
replica uses the table-pull helper, never a walk of the whole table every run:
`core/src/table-pull.js` (`soma-core/table-pull`, or vendor the one
dependency-free file) or `src/soma/table_pull.py` (vendor it; standard library
only). Both expose `pullTable` / `pullTables` (`pull_table` / `pull_tables`).

```js
const { full, rows, deleted, state } = await pullTable({ endpoint, token, table: 'bookmarks', columns: ['url', 'title'], state: saved });
// full: replace your copy with rows. Otherwise upsert rows and drop the deleted ids.
```

- **One request per quiet round.** `POST /v1/cursor {tables}` answers each
  table's newest arrival (`tables`) and how many rows share it (`at_mark`). A
  table whose mark and count equal what the consumer holds is not asked again;
  the rest are pulled `since` the held mark (inclusive, `hub_at >= since`)
  through `{batch:[...]}`, up to 5,000 rows per request. A cold read of a
  small table is two requests.
- **State is the consumer's.** `{v, endpoint, tables: {<t>: {columns, since, n}}}`
  is small JSON kept in the consumer's own store (extension storage, a Durable
  Object, a Modal Volume, a state file), written only after the consumer has
  applied the changes. Losing it costs one full pull.
- **Every pull carries `id`, `hub_at` and `deleted_at`**; the helper adds them.
  A tombstone arrives as a `deleted` id, and as a row with its pulled columns in
  `tombstones` for a consumer that keeps deleted rows.
- **Resets.** Another endpoint, another column list, or a mark behind the held
  cursor (a replaced or restored table, a purged newest row) pulls that table
  in full. A schema change that rewrites existing values in place needs the
  consumer to drop its state. A purge of an older row is invisible to
  incremental pulls: a consumer that must forget purged content drops its state
  now and then.
- **Grants.** A whole-table grant `tables:read:<t>`, or column grants that
  include `id`, `hub_at` and `deleted_at`, or broad `tables:read`. A narrow
  token gets marks only for tables it may read with an arrival cursor.
- **Errors** (a refusal, a malformed answer) throw, with the HTTP status on
  `status`, and leave the caller's state untouched: the next round retries.

## New consumer checklist

1. Choose the grants (grammar in [scoped-enrollment.md](scoped-enrollment.md)).
2. Add the profile to `ENROLLMENT_PROFILES` and deploy.
3. Enroll with pattern A and store the token where the consumer runs.
4. Record the consumer, its profile id and any file prefixes in `AGENTS.md`.
5. Verify: `GET /v1/session` returns the profile receipt and exactly its scopes,
   and a request outside the grants returns 403.
