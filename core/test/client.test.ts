import { afterEach, expect, test } from 'bun:test';
import * as core from '../src/index.ts';
import { schema, TestSql, T0, indexSearch } from './support.ts';
import usage from '../../tests/fixtures/hub-usage-contract.json';

const databases: TestSql[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.db.close(); });
async function local() {
  const db = new TestSql(); databases.push(db);
  for (const ddl of schema) await db.run(ddl);
  await db.run('CREATE TABLE catalog_tables (id TEXT PRIMARY KEY, display TEXT, deleted_at TEXT)');
  await db.run("INSERT INTO catalog_tables(id,display) VALUES ('items','name')");
  await db.run("INSERT INTO catalog_properties(id,tbl,col,type) VALUES ('name','items','name','text'),('qty','items','qty','int')");
  for (let i = 1; i <= 5; i++) await db.run('INSERT INTO items(id,name,qty,created_at,updated_at) VALUES (?,?,?,?,?)', [String(i), `Item ${i}`, i, T0, T0]);
  return db;
}

test('shared row view applies filters, sorting, paging and the core display name', async () => {
  const db = await local();
  const rows = await core.readRows(db, { table: 'items', filters: [{ column: 'qty', op: 'gte', value: 2 }], sort: [{ column: 'qty', direction: 'desc' }], limit: 2, offset: 1 });
  expect(rows.map(r => [r.record.id, r.label])).toEqual([['4', 'Item 4'], ['3', 'Item 3']]);
  await indexSearch(db);
  expect((await core.readRows(db, { table: 'items', search: 'Item 2' })).map(r => r.record.id)).toEqual(['2']);
  expect((await core.readRows(db, { table: 'items', filters: [{ column: 'id', op: 'eq', value: '3' }] }))[0].label).toBe('Item 3');
  await expect(core.readRows(db, { table: 'unknown' })).rejects.toThrow('Table is not in the catalog');
});

test('shared options reuse catalog choices and the adapter read-only seam', async () => {
  const db = await local();
  await db.run("UPDATE catalog_properties SET type='select', options=?, options_sql=? WHERE col='name'", [JSON.stringify([{ v: 'Fixed' }]), "SELECT 'Dynamic' AS value"]);
  expect(await core.readOptions(db, { table: 'items', column: 'name' })).toEqual(['Fixed', 'Dynamic']);
  await expect(core.readOptions(db, { table: 'items', column: 'qty' })).rejects.toThrow('Select property');
});

test('typed handlers execute the same core reads, writes, receipts and service methods', async () => {
  const db = await local();
  const requests: unknown[] = [];
  const hub: core.ServiceHub = { endpoint: 'https://hub.example.test', async get(route) {
    requests.push(route); return { data: route === '/v1/usage' ? usage.usage : usage.notifications };
  }, async post(route, body) { requests.push([route, body]); return { data: usage.mark_read }; } };
  const handlers = core.createCoreHandlers(db, endpoint => { expect(endpoint).toBe(hub.endpoint); return hub; }, 'fixture');
  expect(Object.keys(handlers).sort()).toEqual(['resolveViewDefinition', 'prepareReadPlan', 'calendarRows', 'boardRows', 'listSidebarPins', 'pinTable', 'unpinTable', 'moveTablePin', 'historyEvents', 'previewChanges', 'createProposal', 'listProposals', 'getProposal', 'editProposal', 'previewProposal', 'approveProposal', 'rejectProposal', 'resolveSourceLink', 'mentionedBy', 'mentionLabels', 'viewEmbed', 'resolveDerived', 'saveCatalogProperty', 'saveCatalogRule', 'catalog', 'catalogRevision', 'rows', 'referenceSources', 'referencedBy', 'remoteRows', 'remoteRow', 'search', 'searchIndexStep', 'searchTables', 'setSearchTable', 'listViews', 'getViewDefault', 'ensureDefaultView', 'setViewDefault', 'getRelatedViewDefault', 'setRelatedViewDefault', 'saveView', 'deleteView', 'options', 'write', 'runRowAction', 'undo', 'undoStatus', 'writeability', 'status', 'rejections', 'sync', 'serviceUsage', 'serviceNotifications', 'markNotificationsRead', 'notificationPresentation', 'enrollmentApproval', 'validateDeviceSession', 'enrollmentPollResult', 'sessionRevocationResult', 'validateBackup', 'previewRestore', 'restoreReplica', 'exportReplica', 'hubBackups', 'createHubBackup'].sort());
  expect((await handlers.resolveViewDefinition({ table: 'items', definition: { version: 2, columns: ['name'] } })).view).toEqual({ table: 'items', columns: ['name'] });
  expect(await handlers.resolveSourceLink({url:'https://example.com'})).toEqual({});
  expect(await handlers.rejections({})).toEqual({ rejections: [], nextOffset: null });
  expect(await handlers.writeability({ table: 'items' })).toEqual({ writable: true, reason: null });
  expect(await handlers.searchIndexStep({})).toEqual({ indexing: false, pending: 0, done: true });
  expect((await handlers.search({ text: 'item', table: 'items', limit: 2 })).map(r => r.id)).toEqual(['1', '2']);
  expect((await handlers.catalog({})).tables[0].readOnly).toBe(false);
  const saved = await handlers.write({ table: 'items', patch: { id: '1', name: 'Changed' }, expectedUpdatedAt: T0 });
  expect((await handlers.rows({ table: 'items', filters: [{ column: 'id', op: 'eq', value: '1' }] }))[0].label).toBe('Changed');
  expect((await handlers.status({})).pendingUiEdits).toBe(1);
  await expect(handlers.write({ table: 'items', patch: { id: '1', name: 'Stale' }, expectedUpdatedAt: T0 })).rejects.toThrow('changed');
  expect((await db.all('SELECT updated_at FROM items WHERE id=?', ['1']))[0].updated_at).toBe(saved.updated_at);
  expect(await handlers.serviceUsage({ endpoint: hub.endpoint })).toEqual(usage.usage as core.UsageSummary);
  const feed = await handlers.serviceNotifications({ endpoint: hub.endpoint });
  expect(await handlers.notificationPresentation({ feed, baseline: null })).toEqual({ notifications: [], baseline: 7 });
  expect(await handlers.markNotificationsRead({ endpoint: hub.endpoint, selector: { ids: ['event:1'], through: 7 } })).toEqual({ unread_count: 0 });
  expect(requests).toEqual(['/v1/usage', '/v1/notifications?after=0&limit=200', ['/v1/notifications/read', { ids: ['event:1'], through: 7 }]]);
});
