import {saveCatalogProperty,saveCatalogRule} from './catalog-edit.ts';
import {getViewDefault,setViewDefault,ensureDefaultView,getRelatedViewDefault,setRelatedViewDefault} from './view-defaults.ts';
import { boardRows } from './board-rows.ts';
import { calendarRows } from './calendar-rows.ts';
import type { CoreHandlers, OptionsArgs, View, WorkspaceRow } from './contract.generated.ts';
import {unavailableGovernance,type GovernanceAPI} from './governance-service.ts';
import type { SqlDriver } from './driver.ts';
import type { ServiceHub } from './services.ts';
import { catalogRevision, readCatalog } from './catalog.ts';
import { prepareReadPlan } from './read-plan.ts';
import { referenceSources, referencedBy } from './references.ts';
import { resolveSourceLink } from './source-links.ts';
import { mentionedBy, mentionLabels, viewEmbed } from './mentions.ts';
import { allowed } from './validate.ts';
import { compileView, displayName } from './view.ts';
import { isReadOnlyTable, writeability } from './write.ts';
import { createWriteSession } from './undo.ts';
import { enrollmentApproval, validateDeviceSession, enrollmentPollResult, sessionRevocationResult } from './enrollment.ts';
import { sync } from './sync.ts';
import { syncStatus } from './status.ts';
import { readRejections } from './rejections.ts';
import { openSearchIndex, search, searchIndexStep, searchTables, setSearchTable } from './search.ts';
import { readRemoteRows, readRemoteRow } from './remote.ts';
import { resolveDerived } from './resolve-derived.ts';
import { listViews, saveView, deleteView, resolveViewDefinition } from './saved-views.ts';
import { listSidebarPins, pinTable, unpinTable, moveTablePin } from './sidebar-pins.ts';
import { readUsage, readNotifications, markNotificationsRead, notificationPresentation } from './services.ts';
import { validateBackup, previewRestore, exportReplica, restoreReplica, listHubBackups, createHubBackup, type BackupFiles } from './backup.ts';

/** Shared queries; hosts own serialization, read-only SQL enforcement and locks. */
export async function readRows(db: SqlDriver, view: View): Promise<WorkspaceRow[]> {
  const read = async () => {
    const catalog = await readCatalog(db, view.search ? undefined : [view.table]);
    const table = catalog.tables.find(t => t.id === view.table);
    if (!table) throw new Error('Table is not in the catalog');
    const query = compileView(view, catalog.properties);
    if (view.search) await openSearchIndex(db);
    const rows = await db.all(query.sql, query.params);
    return rows.map(record => ({ record, label: displayName(record, typeof table.display === 'string' ? table.display : undefined) }));
  };
  return view.search ? db.transaction(read) : read();
}

export async function readOptions(db: SqlDriver, { table, column }: OptionsArgs): Promise<string[]> {
  const catalog = await readCatalog(db);
  const property = catalog.properties.find(p => p.tbl === table && p.col === column);
  if (!property || !['select', 'multi_select'].includes(property.type ?? '')) throw new Error('Select property is not in the catalog');
  const rows = property.options_sql ? await db.all(`SELECT * FROM (${property.options_sql})`) : [];
  const extra = rows.map(row => Object.values(row)[0] as string);
  return allowed(property, () => extra);
}

/** Typed local dispatch, not a network protocol. Credentials stay in the host. */
export function createCoreHandlers(db: SqlDriver, hub: (endpoint: string) => ServiceHub, origin = 'local', governance: GovernanceAPI | null = null, files: BackupFiles | null = null): CoreHandlers {
  const writes = createWriteSession(db, origin);
  const backupFiles = () => {
    if (!files) throw new Error('This app cannot open backup files.');
    return files;
  };
  return {
    ...(governance ?? unavailableGovernance()),
    enrollmentApproval,
    validateDeviceSession: ({ data, expectedProfile }) => validateDeviceSession(data, expectedProfile),
    enrollmentPollResult: ({ reply, expectedFingerprint, expectedProfile }) => enrollmentPollResult(reply, expectedFingerprint, expectedProfile),
    sessionRevocationResult,
    async catalog() {
      const catalog = await readCatalog(db);
      return { ...catalog, tables: catalog.tables.map(t => ({ ...t, readOnly: isReadOnlyTable(String(t.id), t) })) };
    },
    catalogRevision: () => catalogRevision(db),
    saveCatalogProperty: args => saveCatalogProperty(db,args),
    saveCatalogRule: args => saveCatalogRule(db,args),
    rows: view => readRows(db, view),
    prepareReadPlan: args => prepareReadPlan(db, args),
    referenceSources: args => referenceSources(db, args),
    referencedBy: args => referencedBy(db, args),
    resolveSourceLink: args => resolveSourceLink(db, args),
    mentionedBy: args => mentionedBy(db, args),
    mentionLabels: args => mentionLabels(db, args),
    viewEmbed: args => viewEmbed(db, args),
    calendarRows,
    boardRows,
    resolveDerived: ({ endpoint, ...args }) => resolveDerived(db, hub(endpoint), args),
    remoteRows: ({ endpoint, ...args }) => readRemoteRows(db, hub(endpoint), args),
    remoteRow: ({ endpoint, ...args }) => readRemoteRow(db, hub(endpoint), args),
    search: args => search(db, args),
    searchIndexStep: args => searchIndexStep(db, args),
    searchTables: args => searchTables(db, args),
    setSearchTable: args => setSearchTable(db, args),
    listViews: args => listViews(db, args),
    resolveViewDefinition: args => resolveViewDefinition(db, args),
    getRelatedViewDefault: args => getRelatedViewDefault(db,args),
    setRelatedViewDefault: args => writes.capturedMutation('related_view_defaults',args,(input,capture)=>setRelatedViewDefault(db,input,{origin},capture)),
    getViewDefault: args => getViewDefault(db,args),
    ensureDefaultView: args => writes.uncapturedMutation(args, input => ensureDefaultView(db,input,{origin})),
    setViewDefault: args => writes.capturedMutation('view_defaults',args,(input,capture)=>setViewDefault(db,input,{origin},capture)),
    saveView: args => writes.capturedMutation('views', args, (input, capture) => saveView(db, input, { origin }, capture)),
    deleteView: args => writes.capturedMutation('views', args, (input, capture) => deleteView(db, input, { origin }, capture)),
    listSidebarPins: args => listSidebarPins(db, args),
    pinTable: args => writes.uncapturedMutation(args, input => pinTable(db,input,{origin})),
    unpinTable: args => writes.uncapturedMutation(args, input => unpinTable(db,input,{origin})),
    moveTablePin: args => writes.uncapturedMutation(args, input => moveTablePin(db,input,{origin})),
    options: args => readOptions(db, args),
    write: writes.write,
    runRowAction: writes.runRowAction,
    undo: writes.undo,
    undoStatus: writes.undoStatus,
    writeability: args => writeability(db, args),
    status: () => syncStatus(db),
    rejections: args => readRejections(db, args),
    sync: args => sync(db, hub(args.endpoint), { maxRows: args.maxRows, tables: args.tables }),
    serviceUsage: args => readUsage(hub(args.endpoint)),
    serviceNotifications: args => readNotifications(hub(args.endpoint)),
    markNotificationsRead: args => markNotificationsRead(hub(args.endpoint), args.selector),
    notificationPresentation: args => notificationPresentation(args.feed, args.baseline),
    validateBackup: async ({ file }) => validateBackup(backupFiles().open(file)),
    previewRestore: async ({ file }) => previewRestore(db, backupFiles().open(file)),
    exportReplica: async ({ file }) => exportReplica(db, backupFiles().create(file)),
    restoreReplica: args => writes.replaceAll(() => restoreReplica(db, backupFiles(), args)),
    hubBackups: ({ endpoint }) => listHubBackups(hub(endpoint)),
    createHubBackup: ({ endpoint }) => createHubBackup(hub(endpoint)),
  };
}
