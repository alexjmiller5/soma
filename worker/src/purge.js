// Purge markers: the one sanctioned hard delete. A row in `purges` names a row
// (col NULL) or one column's history, never its content, and syncs like any
// row. Mirrors purge/apply_purges/_uncovered in src/soma/__init__.py.
import { qident } from "./validate.js";
import { redactReceipts } from './governance-store.js';
import {ScopeDenied} from './scopes.js';
import {purgeChangesets} from './changeset-store.js';
import {markChanged} from './changes.js';

export const PURGES = "purges";

const exists = async (db, t) =>
  !!(await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").bind(t).first());

// (tbl, row_id) -> [[col, purged_at]] for every live marker.
export async function purgeIndex(db) {
  if (!(await exists(db, PURGES))) return new Map();
  const { results } = await db
    .prepare(`SELECT tbl, row_id, col, purged_at FROM ${PURGES} WHERE deleted_at IS NULL`)
    .all();
  const index = new Map();
  for (const m of results ?? []) {
    const key = JSON.stringify([m.tbl, m.row_id]);
    index.set(key, [...(index.get(key) ?? []), [m.col, m.purged_at]]);
  }
  return index;
}

const covers = (index, tbl, id, test) =>
  (index.get(JSON.stringify([tbl, id])) ?? []).some(([col, at]) => test(col, at));
const coversEvent = (index, e) =>
  covers(index, e.tbl, e.row_id, (col, at) => (col == null || col === e.col) && (e.created_at ?? "") <= at);

// Drop pushed copies a marker covers. Silent on purpose: a rejection would pin
// an un-upgraded replica's push cursor forever.
export function uncovered(index, table, rows) {
  if (!index.size || table === PURGES) return rows;
  if (table === "history") return rows.filter((e) => !coversEvent(index, e));
  return rows.filter((r) => !covers(index, table, r.id, (col, at) => col == null && (r.updated_at ?? "") <= at));
}

// The markers covering these rows, in the shape applyPurges takes.
export const markersFor = (index, table, ids) =>
  ids.flatMap((id) => (index.get(JSON.stringify([table, id])) ?? [])
    .map(([col, purged_at]) => ({ tbl: table, row_id: id, col, purged_at })));

// Hard-delete what each live marker covers, stamped at or before purged_at.
export async function applyPurges(db, markers) {
  const live = markers.filter((m) => !m.deleted_at);
  if (!live.length) return;
  if(live.some(m=>typeof m.tbl==='string' && /_governance_/i.test(m.tbl)))throw new ScopeDenied();
  const [hasHistory, hasProvenance] = [await exists(db, "history"), await exists(db, "provenance")];
  const hasReceipts=await exists(db,'_governance_receipts');
  const hasProposals=await exists(db,'_governance_proposals');
  const hasInvalidations=await exists(db,'_governance_invalidations');
  const hasChangesets=await exists(db,'_governance_changesets');
  const stmts = [];
  for (const { tbl, row_id, col, purged_at } of live) {
    if(hasChangesets)stmts.push(...purgeChangesets(db,tbl,row_id));
    if(hasInvalidations)stmts.push(db.prepare(`INSERT INTO _governance_invalidations(tbl,row_id,version) VALUES (?,?,?)
      ON CONFLICT(tbl,row_id) DO UPDATE SET version=excluded.version`).bind(tbl,row_id,crypto.randomUUID()));
    if(hasProposals){
      // Keep only a content-free target/state pointer. Every historical version
      // of an affected proposal disappears, including later edited columns.
      const affected=`SELECT p.id FROM _governance_proposals p JOIN _governance_versions v ON v.proposal_id=p.id
        WHERE p.tbl=? AND p.row_id=? AND (? IS NULL OR EXISTS(SELECT 1 FROM json_each(v.columns_json) WHERE value=?))`;
      if(hasReceipts)stmts.push(db.prepare(`UPDATE _governance_receipts SET result='{"kind":"purged"}',status=200,columns_json='[]'
        WHERE coalesce(json_extract(result,'$.value.proposalId'),json_extract(result,'$.value.id')) IN (${affected})`).bind(tbl,row_id,col,col));
      stmts.push(db.prepare(`UPDATE _governance_proposals SET state='purged' WHERE id IN (${affected})`).bind(tbl,row_id,col,col));
      stmts.push(db.prepare("DELETE FROM _governance_versions WHERE proposal_id IN (SELECT id FROM _governance_proposals WHERE state='purged')"));
    }
    if(hasReceipts)stmts.push(...redactReceipts(db,{table:tbl,rowId:row_id},col));
    if (col == null) {
      if (await exists(db, tbl)) {
        stmts.push(db.prepare(`DELETE FROM ${qident(tbl)} WHERE id = ? AND updated_at <= ?`).bind(row_id, purged_at));
      }
      if (hasProvenance) {
        stmts.push(db.prepare(
          "DELETE FROM provenance WHERE updated_at <= ? AND ((to_kind = ? AND to_ref = ?) OR (from_kind = ? AND from_ref = ?))",
        ).bind(purged_at, tbl, row_id, tbl, row_id));
      }
    }
    if (hasHistory) {
      stmts.push(col == null
        ? db.prepare("DELETE FROM history WHERE tbl = ? AND row_id = ? AND created_at <= ?").bind(tbl, row_id, purged_at)
        : db.prepare("DELETE FROM history WHERE tbl = ? AND row_id = ? AND col = ? AND created_at <= ?").bind(tbl, row_id, col, purged_at));
    }
  }
  if (!stmts.length) return;
  await db.batch(stmts);
  // A hard delete records subscription events like any other commit.
  markChanged(live.map((m) => m.tbl));
}
