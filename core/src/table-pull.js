// Repeated reads of hub tables for a consumer that keeps no replica, the way
// core sync reads them: `/v1/cursor` once per round, then only tables whose
// mark moved, pulled from the held cursor (`hub_at >= since`) in batches.
// Dependency-free on purpose: consumers vendor this one file. The caller keeps
// `state` (small JSON) between rounds and applies each table's changes:
// `full` replaces its copy with `rows`; otherwise upsert `rows`, drop `deleted`
// (`tombstones` carries those rows' pulled columns, for a consumer that keeps
// deleted rows).
// soma: core/src/table-pull.js, docs/consumer-access.md "Reading a table repeatedly".

const MARK = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

export async function pullTables({ endpoint, token, tables, state, watch = [], fetch: send = fetch, headers = {} }) {
  const base = String(endpoint).replace(/\/+$/, '');
  const names = Object.keys(tables ?? {});
  if (!names.length) throw new Error('name at least one table');
  // id/hub_at/deleted_at drive the cursor and tombstones, so every pull carries them.
  const want = Object.fromEntries(names.map(t => [t, [...new Set([...tables[t], 'id', 'hub_at', 'deleted_at'])]]));
  const held = state?.v === 1 && state.endpoint === base ? state.tables ?? {} : {};
  let requests = 0;
  const post = async (route, body) => {
    requests++;
    const response = await send(base + route, {
      method: 'POST', body: JSON.stringify(body),
      headers: { ...headers, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw Object.assign(new Error(`hub ${route} HTTP ${response.status}: ${text.slice(0, 300)}`), { status: response.status });
    }
    return response.json();
  };

  const marks = await post('/v1/cursor', { tables: [...new Set([...names, ...watch])] });
  const batch = marks?.pull_batch;
  if (!marks?.tables || [...names, ...watch].some(t => typeof marks.tables[t] !== 'string' || !(marks.tables[t] === '' || MARK.test(marks.tables[t])))
    || ![batch?.items, batch?.rows].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('invalid cursor response');

  const changes = {}, next = {}, walks = [];
  for (const t of names) {
    const key = want[t].join(','), mark = marks.tables[t], prior = held[t]?.columns === key ? held[t] : null;
    // A mark behind our cursor: the table was replaced, restored or its newest
    // row purged. Only a full pull can tell what is gone.
    const since = prior && mark >= prior.since ? prior.since : '';
    // Inclusive pulls re-read the mark; it is quiet while the hub holds as
    // many rows at the mark as we received there.
    if (prior && since === mark && (mark === '' || marks.at_mark?.[t] === prior.n)) {
      changes[t] = { full: false, rows: [], deleted: [], tombstones: [] };
      next[t] = prior;
    } else walks.push({ t, key, since, mark, rows: [], after: undefined });
  }

  for (let open = walks; open.length;) {
    const asked = open.slice(0, batch.items), limit = Math.floor(batch.rows / asked.length);
    const reply = await post('/v1/rows/pull', { batch: asked.map(w => ({ table: w.t, columns: want[w.t], since: w.since, limit, ...(w.after ? { after: w.after } : {}) })) });
    // Past its byte budget the hub answers a prefix of the pulls asked.
    if (!Array.isArray(reply?.batch) || !reply.batch.length || reply.batch.length > asked.length) throw new Error('invalid pull response');
    reply.batch.forEach((page, i) => {
      const w = asked[i], cursor = page?.next_cursor;
      if (!Array.isArray(page?.rows) || page.rows.some(r => !r || typeof r.id !== 'string')
        || (cursor != null && (typeof cursor !== 'string' || cursor <= (w.after ?? '') || !page.rows.length))) throw new Error('invalid pull response');
      w.rows.push(...page.rows);
      w.after = cursor ?? null;
    });
    open = open.filter(w => w.after !== null);
  }

  for (const w of walks) {
    const tombstones = w.rows.filter(r => r.deleted_at != null);
    changes[w.t] = { full: w.since === '', rows: w.rows.filter(r => r.deleted_at == null), deleted: tombstones.map(r => r.id), tombstones };
    next[w.t] = { columns: w.key, since: w.mark, n: w.rows.filter(r => r.hub_at === w.mark).length };
  }
  // A watched table is marked, never pulled: a consumer reading only a `where`
  // slice of it re-reads the slice when this pair moves.
  const watched = Object.fromEntries(watch.map(t => [t, { mark: marks.tables[t], n: marks.at_mark?.[t] ?? 0 }]));
  return { changes, state: { v: 1, endpoint: base, tables: next }, requests, watched };
}

export async function pullTable({ table, columns, ...options }) {
  const { changes, state, requests, watched } = await pullTables({ ...options, tables: { [table]: columns } });
  return { ...changes[table], state, requests, watched };
}
