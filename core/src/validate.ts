// The catalog row validator: one implementation for the hub and every UI
// client. Mirror of soma.catalog.validate_row (Python); the shared fixture
// tests/fixtures/validation-cases.json is the contract both run.

import type { Row, OptionDef, Property, Violation } from './contract.generated.ts';
export type { Row, OptionDef, Property, Violation } from './contract.generated.ts';

export type ValidateOptions = {
  /** Derived columns the hub is filling in this write (derivation runs only). */
  inDerive?: Set<string>;
  /** Does `table` have a live row with this id? null = do not check refs. */
  refOk?: ((table: string, id: unknown) => boolean) | null;
  /** Values an `options_sql` property allows beyond its static options. */
  extraOptions?: ((p: Property) => string[]) | null;
  /** Columns a partial write carries; null = every column. */
  touched?: Set<string> | null;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const LOCAL_TIME_RE = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE_RE = /^\+?[0-9 ()\-.]{5,}$/;

/** An `updated_at` the sync protocol accepts: exact UTC millisecond ISO-8601. */
export function validEditTimestamp(value: unknown): boolean {
  if (typeof value !== "string" || !DATETIME_RE.test(value) || value.startsWith("0000")) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

/** A floating local time, `YYYY-MM-DDTHH:MM`: that wall-clock time wherever
 * the reader is. No seconds, no zone; the date must exist. */
export function validLocalTime(value: unknown): boolean {
  return typeof value === "string" && LOCAL_TIME_RE.test(value) && validEditTimestamp(`${value.slice(0, 10)}T00:00:00.000Z`);
}

export const empty = (v: unknown): boolean =>
  v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

export function asList(v: unknown): unknown[] | null {
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { return null; }
  }
  return Array.isArray(v) ? v : null;
}

export function same(a: unknown, b: unknown): boolean {
  const la = asList(a), lb = asList(b);
  if (la && lb) return JSON.stringify(la) === JSON.stringify(lb);
  return a === b || (a == null && b == null);
}

/** The values a select / multi_select property allows. */
export function allowed(p: Property, extraOptions?: ((p: Property) => string[]) | null): string[] {
  const vals = (p.options ?? []).map((o) => o.v);
  if (p.options_sql && extraOptions) for (const x of extraOptions(p)) if (!vals.includes(x)) vals.push(x);
  return vals;
}

// Spec order: deprecated, derived, immutable, required, type (incl.
// cardinality), pattern, ref/multi_ref existence. First failure per column
// wins.
//
// `touched` names the columns a partial write actually carries; `after` is
// then the MERGED row. Whole-row rules (required) still see every column, but
// the per-value checks only judge what the writer wrote: a stored value is not
// this write's claim.
export function validateRow(
  props: Property[],
  before: Row | null,
  after: Row,
  { inDerive = new Set(), refOk = null, extraOptions = null, touched = null }: ValidateOptions = {},
): Violation[] {
  const out: Violation[] = [];
  for (const p of props) {
    const col = p.col;
    const v = after[col];
    const was = before ? before[col] : null;
    const changed = before == null ? !empty(v) : !same(v, was);
    const label = p.label ?? col;
    const fail = (rule: string, message: string) => out.push({ col, rule, message });

    if (touched && !touched.has(col)) {
      if (p.required && empty(v)) fail("required", `${label} is required.`);
      continue;
    }
    // Deprecated = kept but hidden: a stored value rides along unjudged; only a
    // write that sets a new value is refused (clearing one is allowed).
    if (p.deprecated) { if (changed && !empty(v)) fail("deprecated", `${col} is deprecated. Never write it.`); continue; }
    if (p.derived_by && changed && !inDerive.has(col)) { fail("derived", `${col} is derived by ${p.derived_by} on the hub. Never write it.`); continue; }
    if (p.immutable && before != null && changed) { fail("immutable", `${col} is set once and never changed.`); continue; }
    if (p.required && empty(v)) { fail("required", `${label} is required.`); continue; }
    if (empty(v)) continue;

    const t = p.type ?? "text";
    if (t === "number" || t === "int") {
      const n = Number(v);
      if (typeof v === "boolean" || v === "" || !Number.isFinite(n)) { fail("type", `${label} must be a number.`); continue; }
      if (t === "int" && !Number.isInteger(n)) { fail("type", `${label} must be an integer.`); continue; }
    } else if (t === "bool" && ![0, 1, true, false].includes(v as number | boolean)) { fail("type", `${label} must be 0 or 1.`); continue; }
    else if (t === "date" && !(typeof v === "string" && DATE_RE.test(v))) { fail("type", `${label} must be YYYY-MM-DD.`); continue; }
    else if (t === "datetime" && !(typeof v === "string" && DATETIME_RE.test(v))) { fail("type", `${label} must be ISO-8601 UTC with milliseconds.`); continue; }
    else if (t === "date_or_datetime" && !(typeof v === "string" && (DATE_RE.test(v) || DATETIME_RE.test(v) || validLocalTime(v)))) { fail("type", `${label} must be YYYY-MM-DD, a YYYY-MM-DDTHH:MM local time or ISO-8601 UTC with milliseconds.`); continue; }
    else if (t === "json") {
      try { typeof v === "string" ? JSON.parse(v) : JSON.stringify(v); } catch { fail("type", `${label} must be JSON.`); continue; }
    } else if (t === "url" && !(typeof v === "string" && /^https?:\/\//.test(v))) { fail("type", `${label} must be an http(s) URL.`); continue; }
    else if (t === "email" && !(typeof v === "string" && EMAIL_RE.test(v))) { fail("type", `${label} must be an email address.`); continue; }
    else if (t === "phone" && !(typeof v === "string" && PHONE_RE.test(v))) { fail("type", `${label} must be a phone number.`); continue; }
    else if (t === "select") {
      const a = allowed(p, extraOptions);
      if (a.length && !a.includes(v as string)) { fail("options", `${v} is not an option for ${col}. Allowed: ${a.join(", ")}`); continue; }
    } else if (t === "multi_select" || t === "multi_ref") {
      const items = asList(v);
      if (!items) { fail("type", `${label} must be a JSON array.`); continue; }
      if (t === "multi_select") {
        const a = allowed(p, extraOptions);
        const bad = items.filter((x) => a.length && !a.includes(x as string));
        if (bad.length) { fail("options", `Not options for ${col}: ${bad.join(", ")}. Allowed: ${a.join(", ")}`); continue; }
      }
      if (p.min_items && items.length < p.min_items) { fail("min_items", `${label} needs at least ${p.min_items}.`); continue; }
      if (p.max_items && items.length > p.max_items) { fail("max_items", `${label} allows at most ${p.max_items}.`); continue; }
    }

    // Pattern runs before ref/multi_ref existence checks (matches Python).
    if (p.pattern && typeof v === "string" && !new RegExp(`^(?:${p.pattern})$`).test(v)) { fail("pattern", `${label} is not in the expected form.`); continue; }

    if (t === "ref" && refOk && p.ref_table && !refOk(p.ref_table, v)) { fail("ref", `No ${p.ref_table} row with id ${v}.`); continue; }
    if (t === "multi_ref" && refOk && p.ref_table) {
      const missing = (asList(v) ?? []).filter((x) => !refOk(p.ref_table as string, x));
      if (missing.length) { fail("ref", `No ${p.ref_table} row: ${missing.join(", ")}`); continue; }
    }
  }
  return out;
}

// Every identifier interpolated into SQL passes through here first. `ident`
// validates and returns the bare name; `qident` is what goes into SQL - quoted,
// so a column named `cast` or `order` is legal.
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function ident(name: string): string {
  if (!SAFE_IDENT.test(name)) throw new Error(`unsafe identifier: ${name}`);
  return name;
}

export function qident(name: string): string {
  return `"${ident(name)}"`;
}
