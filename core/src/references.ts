import type {
  Catalog,
  ReferenceSource,
  ReferenceSourcesArgs,
  ReferencedByArgs,
  ReferencedByPage,
} from "./contract.generated.ts";
import type { SqlDriver } from "./driver.ts";
import { readCatalog } from "./catalog.ts";
import { skippedTableNames } from "./status.ts";
import { getRelatedViewDefault } from "./view-defaults.ts";
import { openSearchIndex } from "./search.ts";
import { displayName,compileReferenceView } from "./view.ts";

function checkArgs(
  value: unknown,
  keys: string[],
  required: string[],
): asserts value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.keys(value).some((key) => !keys.includes(key)) ||
    required.some(
      (key) =>
        typeof (value as Record<string, unknown>)[key] !== "string" ||
        !(value as Record<string, unknown>)[key],
    )
  )
    throw Error("Invalid reference arguments");
}
async function context(
  db: SqlDriver,
  table: string,
): Promise<{ catalog: Catalog; sources: ReferenceSource[] }> {
  const catalog = await readCatalog(db);
  if (!catalog.tables.some((entry) => entry.id === table))
    throw Error("Table is not in the catalog");
  const skipped = new Set(await skippedTableNames(db));
  const tables = new Set(catalog.tables.map((entry) => entry.id));
  const sources: ReferenceSource[] = [];
  for (const property of catalog.properties) {
    if (
      typeof property.tbl !== "string" ||
      !tables.has(property.tbl) ||
      property.ref_table !== table ||
      !["ref", "multi_ref"].includes(property.type ?? "")
    )
      continue;
    sources.push({
      table: property.tbl,
      column: property.col,
      label: property.label?.trim() || property.col,
      type: property.type as "ref" | "multi_ref",
      incomplete: skipped.has(property.tbl) || skipped.has(table),
    });
  }
  return { catalog, sources };
}

/** Metadata only. Hosts request each group's rows lazily. */
export async function referenceSources(
  db: SqlDriver,
  args: ReferenceSourcesArgs,
): Promise<ReferenceSource[]> {
  checkArgs(args, ["table"], ["table"]);
  return db.transaction(async () => (await context(db, args.table)).sources);
}

/** Incoming links use the target's own identity affinity/collation. A plain
 * source-column equality would lose valid links to case-insensitive IDs. */
export async function referencedBy(
  db: SqlDriver,
  args: ReferencedByArgs,
): Promise<ReferencedByPage> {
  checkArgs(
    args,
    ["table", "rowId", "sourceTable", "column", "limit", "offset", "calendar", "expectedViewUpdatedAt"],
    ["table", "rowId", "sourceTable", "column"],
  );
  const limit = args.limit === undefined ? 20 : args.limit,
    offset = args.offset === undefined ? 0 : args.offset;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > Number.MAX_SAFE_INTEGER - limit - 1
  )
    throw Error("Invalid reference pagination");
  return db.transaction(async () => {
    const { catalog, sources } = await context(db, args.table);
    const source = sources.find(
      (entry) =>
        entry.table === args.sourceTable && entry.column === args.column,
    );
    if (!source) throw Error("Reference source is not in the catalog");
    // Preferences are read in this same transaction; table defaults do not affect links.
    const preference=await getRelatedViewDefault({all:db.all.bind(db),run:db.run.bind(db),transaction:body=>body()}, {table:source.table});
    if(args.expectedViewUpdatedAt!==undefined && args.expectedViewUpdatedAt!==preference.view?.updated_at)throw Error('The related-record view changed; refresh relationships before retrying.');
    const view={...(preference.view?.view ?? {table:source.table}),columns:undefined,trash:false,limit:limit+1,offset,calendar:args.calendar};
    const query=compileReferenceView(view,catalog.properties,{table:args.table,rowId:args.rowId,column:source.column,type:source.type});
    if(view.search)await openSearchIndex(db);
    const rows=await db.all(query.sql,query.params);
    const display = catalog.tables.find(
      (table) => table.id === source.table,
    )?.display;
    return {
      source,
      ...(preference.unavailable && !/provision/i.test(preference.unavailable)?{viewUnavailable:preference.unavailable}:{}),
      rows: rows.slice(0, limit).map((record) => ({
        record,
        label: displayName(
          record,
          typeof display === "string" ? display : undefined,
        ),
      })),
      nextOffset: rows.length > limit ? offset + limit : null,
    };
  });
}
