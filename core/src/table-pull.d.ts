export type PullState = { v: 1; endpoint: string; tables: Record<string, { columns: string; since: string; n: number }> } | null | undefined;
export type TableChanges = { full: boolean; rows: Array<Record<string, unknown> & { id: string }>; deleted: string[]; tombstones: Array<Record<string, unknown> & { id: string }> };
type Options = {
  endpoint: string;
  token: string;
  state: PullState;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  headers?: Record<string, string>;
};
export function pullTables(options: Options & { tables: Record<string, string[]> }): Promise<{ changes: Record<string, TableChanges>; state: Exclude<PullState, null | undefined>; requests: number }>;
export function pullTable(options: Options & { table: string; columns: string[] }): Promise<TableChanges & { state: Exclude<PullState, null | undefined>; requests: number }>;
