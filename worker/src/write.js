// D1 has transactional batch(), not an interactive JavaScript transaction.
// Keep preflight honest with read-set assertions inside the same batch.
import { historyPlan, historyStatements } from './history.js';
import { literal, qident, validatePush } from './validate.js';
import {assertPublicSql} from './governance-isolation.js';
import { markChanged } from './changes.js';
import { supportedRuleSql } from '../../core/src/rule-sql.ts';

const quoteColumn = (v) => '"' + v.replaceAll('"', '""') + '"';
const JSON_BYTES = 256 * 1024;
const byteLength = value => new TextEncoder().encode(value).length;
// D1 rejects a compound SELECT with more than five terms. Larger unions nest
// groups of five as subqueries; term order (and so bind order) is unchanged.
const D1_COMPOUND_TERMS = 5;
function unionAll(terms) {
  while(terms.length>D1_COMPOUND_TERMS){
    const groups=[];
    for(let i=0;i<terms.length;i+=D1_COMPOUND_TERMS)groups.push(`SELECT * FROM (${terms.slice(i,i+D1_COMPOUND_TERMS).join(' UNION ALL ')})`);
    terms=groups;
  }
  return terms.join(' UNION ALL ');
}

// Keep each JSON value well below D1's length limit, including UTF-8 and JSON
// escaping. A single oversized row must use native cells instead.
function jsonChunks(rows) {
  const chunks=[];
  let chunk=[],bytes=2;
  for(const row of rows){
    const encoded=JSON.stringify(row),size=byteLength(encoded);
    if(size+2>JSON_BYTES)return null;
    if(bytes+size+Number(chunk.length>0)>JSON_BYTES){chunks.push('['+chunk.join(',')+']');chunk=[];bytes=2;}
    chunk.push(encoded);bytes+=size+Number(chunk.length>1);
  }
  if(chunk.length)chunks.push('['+chunk.join(',')+']');
  return chunks;
}

export function checkedReads(db) {
  const reads = new Map();
  return {
    reads,
    prepare(sql) {
      let args = [];
      const read = async (first) => {
        let query = first ? `SELECT * FROM (${sql}) LIMIT 1` : sql;
        const key = JSON.stringify([query, args]);
        if (!reads.has(key)) {
          let { results } = await db.prepare(query).bind(...args).all();
          // D1 exposes numbers as doubles. Preserve unsafe SQLite INTEGERs as
          // decimal text in BOTH the read and its later guard; leave REALs as
          // numbers. A rounded preflight snapshot can never authorize a write.
          if (results?.some(row=>Object.values(row).some(v=>typeof v==='number' && Number.isInteger(v) && !Number.isSafeInteger(v)))) {
            const columns=Object.keys(results[0]);
            query=`SELECT ${columns.map(c=>{
              const name=quoteColumn(c);
              return `CASE WHEN typeof(${name})='integer' AND (${name}>9007199254740991 OR ${name} < -9007199254740991) THEN CAST(${name} AS TEXT) ELSE ${name} END AS ${name}`;
            }).join(',')} FROM (${query})`;
            ({results}=await db.prepare(query).bind(...args).all());
          }
          reads.set(key, { sql: query, args: [...args], rows: results ?? [] });
        }
        const rows = reads.get(key).rows;
        return first ? rows[0] ?? null : { results: rows };
      };
      return { bind(...values) { args = values; return this; }, all: () => read(false), first: () => read(true) };
    },
    // Many independent reads in one round trip, cached as the reads later
    // asked for. A failed batch (a missing table) leaves them to run one by
    // one, and so does a row with an unsafe integer, which needs the re-read.
    async prefetch(list) {
      const todo = new Map();
      for (const [sql, args, first] of list) {
        const query = first ? `SELECT * FROM (${sql}) LIMIT 1` : sql, key = JSON.stringify([query, args]);
        todo.set(key, { sql: query, args });
      }
      let results;
      try { results = await db.batch([...todo.values()].map(({ sql, args }) => db.prepare(sql).bind(...args))); } catch { return; }
      [...todo].forEach(([key, read], i) => {
        const rows = results[i].results ?? [];
        if (rows.some(row=>Object.values(row).some(v=>typeof v==='number' && Number.isInteger(v) && !Number.isSafeInteger(v)))) return;
        reads.set(key, { ...read, rows });
      });
    },
  };
}

export function readGuards(db, reads) {
  const guards=[];
  const assertion=(equal,args)=>db.prepare(`SELECT CASE WHEN (${equal}) THEN 1 ELSE abs(-9223372036854775808) END AS life_write_conflict`).bind(...args);
  for(const {sql,args,rows} of reads.values()){
    if(!rows.length){guards.push(assertion(`NOT EXISTS (${sql})`,args));continue;}
    const cols=Object.keys(rows[0]);
    const prefix='_life_write_'+crypto.randomUUID().replaceAll('-','');
    const [actualName,expectedName,nativeName]=['actual','expected','native'].map(n=>qident(prefix+'_'+n));
    const equal=(actual,expected,columns)=>{
      const keys=columns.map(c=>quoteColumn(c)+' COLLATE BINARY').join(',');
      // Include multiplicity and explicit binary equality, independent of source
      // column collation. Matching only DISTINCT rows can miss duplicate drift.
      const a=`SELECT ${keys},count(*) FROM ${actualName} GROUP BY ${keys}`;
      const e=`SELECT ${keys},count(*) FROM ${expectedName} GROUP BY ${keys}`;
      return `WITH ${actualName} AS (${actual}),${expectedName} AS (${expected})
        SELECT NOT EXISTS (${a} EXCEPT ${e}) AND NOT EXISTS (${e} EXCEPT ${a})`;
    };
    const numbers=[...new Set(rows.flatMap(row=>Object.values(row).filter(v=>typeof v==='number' && !Number.isSafeInteger(v))))];
    if(numbers.length+args.length+1<=99){
      const index=new Map(numbers.map((n,i)=>[n,i]));
      const encoded=rows.map(row=>Object.fromEntries(Object.entries(row).map(([c,v])=>[c,index.has(v)?{native:index.get(v)}:v])));
      const chunks=jsonChunks(encoded);
      if(chunks && numbers.length+args.length+chunks.length<=99){
        const expected=cols.map(c=>{
          const path=literal('$.'+JSON.stringify(c)),value=`json_extract(j.value,${path})`;
          return (numbers.length?`CASE WHEN json_type(j.value,${path})='object' THEN (SELECT n.value FROM ${nativeName} n WHERE n.id=json_extract(${value},'$.native')) ELSE ${value} END`:value)+` AS ${quoteColumn(c)}`;
        }).join(',');
        // Repeated native values share one binding. This keeps bulk snapshots
        // cheap without passing any REAL through SQLite's JSON number parser.
        // IDs are SQL integer literals, leaving exactly one bind per native value.
        const nativeSQL=numbers.length?`${nativeName}(id,value) AS (VALUES ${numbers.map((_,i)=>`(${i},?)`).join(',')}),`:'';
        const source=unionAll(chunks.map(()=>'SELECT value FROM json_each(?)'));
        const guard=equal(sql,`SELECT ${expected} FROM (${source}) j`,cols).replace(`WITH ${actualName} AS`,`WITH ${nativeSQL}${actualName} AS`);
        guards.push(assertion(guard,[...numbers,...args,...chunks]));
        continue;
      }
    }
    // SQLite JSON numeric parsing can change a double by one ULP. Native binds
    // preserve those values; bounded slices stay below D1's parameter limit.
    const capacity=99-args.length;
    if(capacity<cols.length)throw new Error('life_write_budget');
    guards.push(assertion(`(SELECT count(*) FROM (${sql}))=${rows.length}`,args));
    // Every distinct expected row must retain its GLOBAL multiplicity, and
    // total cardinality excludes extra rows. This is independent of query
    // order and never loses correlations by comparing columns separately.
    const groups=new Map();
    for(const row of rows){
      const key=JSON.stringify(cols.map(c=>typeof row[c]==='number'?['number',String(row[c])]:row[c]));
      if(groups.has(key))groups.get(key).count++;
      else groups.set(key,{row,count:1});
    }
    const keys=cols.map(c=>quoteColumn(c)+' COLLATE BINARY').join(',');
    const countName=quoteColumn(prefix+'_count');
    const actual=`SELECT ${keys},count(*) AS ${countName} FROM (${sql}) GROUP BY ${keys}`;
    const unique=[...groups.values()],step=Math.floor(capacity/cols.length);
    for(let offset=0;offset<unique.length;offset+=step){
      const slice=unique.slice(offset,offset+step);
      const expected=unionAll(slice.map(({count})=>`SELECT ${cols.map(c=>'? AS '+quoteColumn(c)).join(',')},${count} AS ${countName}`));
      guards.push(assertion(`WITH ${actualName} AS (${actual}),${expectedName} AS (${expected})
        SELECT NOT EXISTS (SELECT * FROM ${expectedName} EXCEPT SELECT * FROM ${actualName})`,
      [...args,...slice.flatMap(({row})=>cols.map(c=>row[c]))]));
    }
  }
  return guards;
}

export async function enforcedRules(db, table) {
  if (!await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='catalog_rules'").first()) return [];
  const { results } = await db.prepare("SELECT * FROM catalog_rules WHERE deleted_at IS NULL AND tbl=? AND kind='invariant' AND enforce=1 ORDER BY id").bind(table).all();
  for(const rule of results ?? [])assertPublicSql(rule.sql);
  return results ?? [];
}

// Triggers exist only inside this batch transaction. No temp schema or user
// context tables; OLD/NEW have SQLite's actual types, defaults and values.
export async function prepareChecked(db, table, rules, statements, now, history = null, expected = [], props = [], transitions = [], probe = false, {finalState = false} = {}) {
  const key = '_life_write_' + crypto.randomUUID().replaceAll('-', '');
  const schema = (await db.prepare(`PRAGMA table_info(${qident(table)})`).all()).results;
  const cols = schema.map(c => c.name);
  for (const p of props) if (p.options_sql && ['select','multi_select'].includes(p.type) && p.optionColumn == null) {
    // D1 supplies column names even for empty results. Schema/catalog read
    // guards protect this metadata; values are still checked at each mutation.
    const [columns] = await db.prepare(`SELECT * FROM (${p.options_sql}) LIMIT 0`).raw({columnNames:true});
    p.optionColumn = columns[0];
  }
  const context = (prefix) => cols.map(c => `${prefix}.${qident(c)} AS ${qident(c)}`).join(',');
  const begin = [];
  const end = [];
  const checks = [];
  const snapshot = key + '_before', validation = key + '_validation';
  if (finalState) {
    if (!expected.length) throw new Error('Final-state validation needs explicit targets');
    begin.push(db.prepare(`CREATE TABLE ${qident(snapshot)} AS SELECT * FROM ${qident(table)} WHERE id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(expected.map(r=>r.id))));
    begin.push(db.prepare(`CREATE TABLE ${qident(validation)} (ok INTEGER CONSTRAINT life_invariant_final CHECK(ok=1))`));
    end.push(db.prepare(`DROP TABLE ${qident(snapshot)}`),db.prepare(`DROP TABLE ${qident(validation)}`));
    for (const rule of rules) {
      if (!supportedRuleSql(rule.sql)) throw new Error('invalid invariant SELECT');
      checks.push(db.prepare(`INSERT INTO ${qident(validation)} SELECT 0 WHERE EXISTS (
        WITH changed AS (SELECT * FROM ${qident(table)} WHERE id IN (SELECT value FROM json_each(?))),
          before AS (SELECT * FROM ${qident(snapshot)}), now AS (SELECT ? AS ts)
        ${rule.sql})`).bind(JSON.stringify(expected.map(r=>r.id)),now));
    }
  }
  const approval = key + '_approved',numbers=key+'_numbers';
  // Large unchanged stored text must not be expanded into an oversized JSON
  // approval value by a sparse write. Native cells also preserve exact REALs.
  const nativeValues=[...new Set(expected.flatMap(row=>Object.entries(row)
    .filter(([c,v])=>!['id','updated_at','hub_at'].includes(c) && typeof v==='number' && !Number.isSafeInteger(v))
    .map(([,v])=>v)))];
  const nativeIndex=new Map(nativeValues.map((n,i)=>[n,i]));
  if (expected.length) {
    const approved=expected.map(({hub_at,...row},i)=>({
      // Dependency checks address these two fields directly in the JSON.
      row:Object.fromEntries(Object.entries(row).map(([c,v])=>[c,!['id','updated_at'].includes(c) && nativeIndex.has(v)?{native:nativeIndex.get(v)}:v])),
      touched:transitions[i]?.touched ?? Object.keys(row),
    }));
    for(const envelope of approved){
      // Size exactly what jsonChunks stores, including native-number markers,
      // touched fields and the enclosing array. Raw row size omits that cost.
      if(byteLength(JSON.stringify([envelope]))<=JSON_BYTES)continue;
      for(const [c,v] of Object.entries(envelope.row))if(!['id','updated_at'].includes(c) && typeof v==='string'){
        if(!nativeIndex.has(v)){nativeIndex.set(v,nativeValues.length);nativeValues.push(v);}
        envelope.row[c]={native:nativeIndex.get(v)};
      }
    }
    const chunks=jsonChunks(approved);
    if(!chunks)throw new Error('life_write_budget');
    begin.push(db.prepare(`CREATE TABLE ${qident(approval)} AS SELECT value FROM json_each(?)`).bind(chunks[0]));
    for(const chunk of chunks.slice(1))begin.push(db.prepare(`INSERT INTO ${qident(approval)} SELECT value FROM json_each(?)`).bind(chunk));
    // No affinity: binding a numeric-looking TEXT must never coerce its type.
    begin.push(db.prepare(`CREATE TABLE ${qident(numbers)} (id INTEGER,value)`));
    for(let i=0;i<nativeValues.length;i+=99){
      const chunk=nativeValues.slice(i,i+99);
      begin.push(db.prepare(`INSERT INTO ${qident(numbers)} VALUES ${chunk.map((_,j)=>`(${i+j},?)`).join(',')}`).bind(...chunk));
    }
    end.unshift(db.prepare(`DROP TABLE ${qident(approval)}`),db.prepare(`DROP TABLE ${qident(numbers)}`));
  }
  if (rules.length || expected.length) for (const event of ['INSERT', 'UPDATE']) {
    const trigger = key + '_' + event.toLowerCase();
    let triggerChecks = (finalState ? [] : rules).map((rule, i) => {
      if (!supportedRuleSql(rule.sql)) throw new Error('invalid invariant SELECT');
      const before = event === 'UPDATE' ? `SELECT ${context('OLD')}` : `SELECT ${context('NEW')} WHERE 0`;
      return `SELECT RAISE(ABORT, 'life_invariant_${i}') WHERE EXISTS (
        WITH changed AS (SELECT ${context('NEW')}), before AS (${before}), now AS (SELECT ${literal(now)} AS ts)
        ${rule.sql});`;
    }).join('\n');
    if (expected.length) {
      const matches = cols.map(c=>{
        const path=literal('$.row."'+c+'"'),actual=`NEW.${qident(c)} COLLATE BINARY`,value=`json_extract(a.value,${path})`;
        // Trigger NEW operands do not inherit a table column's comparison
        // affinity. Match lossless INTEGER decimal text explicitly.
        const integer=/INT/i.test(schema.find(s=>s.name===c).type)
          ? ` OR (typeof(${actual})='integer' AND json_type(value,${path})='text' AND CAST(${actual} AS TEXT) IS ${value})` : '';
        const nativeInteger=integer ? ` OR (typeof(${actual})='integer' AND typeof(n.value)='text' AND CAST(${actual} AS TEXT) IS n.value)` : '';
        if(!nativeValues.length)return `(json_type(a.value,${path}) IS NULL OR ${actual} IS ${value}${integer})`;
        return `(json_type(a.value,${path}) IS NULL OR CASE WHEN json_type(a.value,${path})='object'
          THEN EXISTS (SELECT 1 FROM ${qident(numbers)} n WHERE n.id=json_extract(${value},'$.native') AND (${actual} IS n.value${nativeInteger}))
          ELSE (${actual} IS ${value}${integer}) END)`;
      }).join(' AND ');
      if (!finalState) triggerChecks += dependencyChecks(props, event, approval);
      triggerChecks += ` SELECT RAISE(ABORT, 'life_write_conflict') WHERE NOT EXISTS (SELECT 1 FROM ${qident(approval)} a WHERE ${matches});`;
    }
    begin.push(db.prepare(`CREATE TRIGGER ${qident(trigger)} AFTER ${event} ON ${qident(table)} BEGIN ${triggerChecks} END`));
    end.unshift(db.prepare(`DROP TRIGGER ${qident(trigger)}`));
  }
  if (finalState) for (const {condition} of dependencyConditions(props,'UPDATE',approval)) {
    checks.push(db.prepare(`INSERT INTO ${qident(validation)} SELECT 0 WHERE EXISTS (
      SELECT 1 FROM ${qident(table)} AS NEW WHERE NEW.id IN (SELECT value FROM json_each(?)) AND (${condition}))`)
      .bind(JSON.stringify(expected.map(r=>r.id))));
  }
  const log = historyStatements(db, table, key, history);
  if (probe) {
    // Deliberate final failure rolls the entire successful probe back. The
    // named CHECK distinguishes it from a real guard/SQL failure; its table
    // is created after all user reads/writes and can never persist.
    end.push(db.prepare(`CREATE TABLE ${qident(key + '_probe')} (ok INTEGER CONSTRAINT life_probe_complete CHECK(ok=1))`));
    end.push(db.prepare(`INSERT INTO ${qident(key + '_probe')} VALUES (0)`));
  }
  return {begin:[...begin,...log.begin],statements,checks,end:[...log.end,...end]};
}

// A trusted service can compose prepared table plans into ONE batch. Preparing
// a plan never executes its statements; every participating read guard belongs
// before all plan setup and mutations. Ordinary single-table callers retain the
// same execution path and expose receipts only after the whole batch commits.
export async function commitChecked(db, reads, table, rules, statements, now, history = null, expected = [], props = [], transitions = [], probe = false) {
  const guards=readGuards(db,reads);
  const plan=await prepareChecked(db,table,rules,statements,now,history,expected,props,transitions,probe);
  try {
    const result = await db.batch([...guards,...plan.begin,...plan.statements,...plan.end]);
    if (!probe && transitions.length) markChanged([table]);
    return result.slice(guards.length+plan.begin.length,guards.length+plan.begin.length+plan.statements.length);
  }
  catch (e) {
    if (probe && String(e).includes('life_probe_complete')) return;
    throw e;
  }
}

const budgeted = new WeakSet();
export function queryBudget(db, maximum) {
  if (budgeted.has(db)) return db;
  let queries = 0;
  const wrapper = {
    prepare(sql) {
      if (++queries > maximum || new TextEncoder().encode(sql).length > 100_000) {
        throw new Error('life_write_budget');
      }
      return db.prepare(sql);
    },
    batch: statements => db.batch(statements),
    remaining: () => maximum - queries,
  };
  budgeted.add(wrapper);
  return wrapper;
}

const rejectAll = (rows, rule, message) => ({accepted:[],rejected:rows.map(row=>({id:row.id,col:null,rule,message}))});

export async function pushChecked(db, table, rows, upsertSql, stamping, history = [], insertOnly = false, policy = null) {
  // Include rollback-only isolation probes in the same request budget.
  db = queryBudget(db,750);
  const attempt = (rows, probe=false) => pushAttempt(db,table,rows,upsertSql,stamping,history,probe,insertOnly,policy);
  try {
    return history.length ? await pushAtomicHistory(rows,attempt) : await pushGroup(rows,attempt);
  } catch (e) {
    if (e.code === 'history-ambiguity') {
      const out=rejectAll(rows,e.code,e.message);
      for (const r of out.rejected) r.retryable=true;
      return out;
    }
    if (e.code === 'write-conflict') return rejectAll(rows,e.code,e.message);
    if (String(e).includes('life_write_budget')) return rejectAll(rows,'write-budget','Write budget reached; retry this row in a smaller batch.');
    throw e;
  }
}

// With original events, no sibling may commit until ALL history decisions
// are known. Invalid batches are isolated using rollback-only prefix probes;
// then the accepted sequence is revalidated and committed in one transaction.
async function pushAtomicHistory(rows, attempt) {
  try { return await attempt(rows); }
  catch (e) { if (!e.failure) throw e; }
  const conflict = () => Object.assign(new Error('Write changed during isolation; retry against current state.'), {code:'write-conflict'});
  const isolate = async (rows, prefix=[]) => {
    let failure;
    try {
      const out = await attempt([...prefix,...rows],true);
      if (!prefix.every((r,i)=>out.accepted[i]?.id===r.id && out.accepted[i]?.updated_at===r.updated_at)) throw conflict();
      return out;
    } catch (e) {
      if (!e.failure) throw e;
      if (!prefix.every((r,i)=>e.accepted[i]?.id===r.id && e.accepted[i]?.updated_at===r.updated_at)) throw conflict();
      failure=e;
    }
    if (rows.length === 1) return {accepted:prefix,rejected:[...failure.rejected,{id:rows[0].id,...failure.failure}]};
    const mid=Math.floor(rows.length/2);
    const left=await isolate(rows.slice(0,mid),prefix);
    const right=await isolate(rows.slice(mid),left.accepted);
    return {accepted:right.accepted,rejected:[...left.rejected,...right.rejected]};
  };
  const isolated=await isolate(rows);
  try {
    const out=await attempt(isolated.accepted);
    return {accepted:out.accepted,rejected:[...isolated.rejected,...out.rejected]};
  } catch (e) {
    if (e.failure) throw conflict();
    throw e;
  }
}

// Without attached originals, preserve the existing cheap ordered isolation.
async function pushGroup(rows, attempt) {
  try { return await attempt(rows); }
  catch (e) {
    if (String(e).includes('life_write_budget')) return rejectAll(rows,'write-budget','Write budget reached; retry this row in a smaller batch.');
    if (!e.failure) throw e;
    if (rows.length > 1) {
      const mid=Math.floor(rows.length/2);
      const left=await pushGroup(rows.slice(0,mid),attempt);
      const right=await pushGroup(rows.slice(mid),attempt);
      return {accepted:[...left.accepted,...right.accepted],rejected:[...left.rejected,...right.rejected],
        existing:[...(left.existing ?? []),...(right.existing ?? [])]};
    }
    return {accepted:[],rejected:[...e.rejected,{id:rows[0].id,...e.failure}],existing:e.existing ?? []};
  }
}

async function pushAttempt(db, table, rows, upsertSql, stamping, history, probe, insertOnly, policy) {
  if (!rows.length) return {accepted:[],rejected:[]};
  const view=checkedReads(db);
  if (policy) await policy(view,table,true,rows.map(row=>row.id));
  await view.prepare("SELECT name, sql FROM sqlite_master WHERE type IN ('table','trigger') AND name NOT LIKE '_cf_%' AND name NOT GLOB '_life_write_*' ORDER BY name").all();
  const {accepted,rejected,expected,props,transitions,existing}=await validatePush(view,table,rows,db,insertOnly);
  if (!accepted.length) return {accepted,rejected,existing};
  const rules=await enforcedRules(view,table);
  let log;
  try { log=insertOnly ? null : await historyPlan(view,db,table,accepted,history,transitions,upsertSql); }
  catch (e) {
    if (!String(e).includes('life_history')) throw e;
    throw Object.assign(e,{accepted,rejected,failure:{col:null,rule:'history',message:String(e)}});
  }
  const groups=[];
  for (const row of accepted) {
    const cols=Object.keys(row), last=groups.at(-1);
    if (last && last.cols.join(',')===cols.join(',')) last.rows.push(row);
    else groups.push({cols,rows:[row]});
  }
  const statements=groups.map(({cols,rows})=>db.prepare(upsertSql(table,cols,stamping))
    .bind(JSON.stringify(rows)));
  try {
    const receipts = await commitChecked(db,view.reads,table,rules,statements,new Date().toISOString(),log,expected,props,transitions,probe);
    if (insertOnly) {
      const inserted = new Set(receipts.flatMap(r=>(r.results ?? []).map(row=>row.id)));
      // A trigger can suppress an INSERT. Absence of a receipt is not proof
      // that the ID exists, nor permission to acknowledge a creation.
      for (const row of accepted) if (!inserted.has(row.id)) rejected.push({id:row.id,col:null,
        rule:'write-conflict',retryable:true,message:'No insert receipt; retry against current state.'});
      return {accepted:accepted.filter(row=>inserted.has(row.id)),rejected,existing};
    }
    return {accepted,rejected};
  } catch (e) {
    const outbox = /life_outbox_(capacity|event_size)/.exec(String(e));
    if (outbox) {
      const retryable = outbox[1] === 'capacity';
      throw Object.assign(e,{accepted,rejected,existing,failure:{col:null,
        rule:retryable?'outbox-capacity':'outbox-event-size',retryable,
        message:retryable?'Change outbox capacity reached; drain pending events and retry.':'Change event exceeds the durable delivery size limit.'}});
    }
    if (!/life_invariant_|life_property_|life_write_conflict|integer overflow/.test(String(e))) throw e;
    const property=/life_property_(\d+)_(ref|options)/.exec(String(e));
    const index=/life_invariant_(\d+)/.exec(String(e));
    const rule=index ? rules[Number(index[1])] : null;
    const failure=property
      ? {col:props[Number(property[1])].col,rule:property[2],message:'Value is not allowed by the current dependency state.'}
      : {col:rule?.col ?? null,rule:rule?.id ?? 'write-conflict',message:rule?.text ?? 'Write could not be committed; retry against current state.'};
    if (insertOnly && failure.rule === 'write-conflict') failure.retryable = true;
    throw Object.assign(e,{accepted,rejected,existing,failure});
  }
}

// Dependencies can change earlier in this same batch. Check them at NEW,
// retaining sparse UPDATE semantics and the original public rejection shape.
function dependencyChecks(props, event, approval) {
  return dependencyConditions(props,event,approval).map(({condition,error})=>
    `SELECT RAISE(ABORT,${literal(error)}) WHERE ${condition};`).join('\n');
}

function dependencyConditions(props, event, approval) {
  return props.flatMap((p,i)=> {
    const v = `NEW.${qident(p.col)}`;
    const touched = event === 'INSERT' ? '1' : `EXISTS (SELECT 1 FROM ${qident(approval)} a, json_each(a.value,'$.touched') t WHERE json_extract(a.value,'$.row.id') IS NEW.id AND (json_extract(a.value,'$.row.updated_at') IS NULL OR json_extract(a.value,'$.row.updated_at') IS NEW.updated_at) AND t.value=${literal(p.col)})`;
    const active = `NEW.deleted_at IS NULL AND ${touched} AND ${v} IS NOT NULL AND ${v} <> ''`;
    const checks = [];
    if (p.ref_table && ['ref','multi_ref'].includes(p.type)) {
      const missing = x=>`NOT EXISTS (SELECT 1 FROM ${qident(p.ref_table)} WHERE id=${x} AND deleted_at IS NULL)`;
      const invalid = p.type === 'ref' ? missing(v) : `EXISTS (SELECT 1 FROM json_each(${v}) item WHERE ${missing('item.value')})`;
      checks.push({error:`life_property_${i}_ref`,condition:`${active} AND ${invalid}`});
    }
    if (p.options_sql && ['select','multi_select'].includes(p.type)) {
      // Our transaction-lifetime helper objects are not user schema options.
      const query = `WITH sqlite_master AS (SELECT * FROM main.sqlite_master WHERE name NOT GLOB '_life_write_*') SELECT ${quoteColumn(p.optionColumn)} FROM (${p.options_sql})`;
      const choices = `WITH choices(v) AS (${query}) SELECT v FROM choices UNION SELECT json_extract(value,'$.v') FROM json_each(${literal(JSON.stringify(p.options ?? []))})`;
      const invalid = p.type === 'select' ? `NOT EXISTS (SELECT 1 FROM allowed WHERE v IS ${v})` : `EXISTS (SELECT 1 FROM json_each(${v}) item WHERE NOT EXISTS (SELECT 1 FROM allowed WHERE v IS item.value))`;
      checks.push({error:`life_property_${i}_options`,condition:`${active} AND (WITH allowed AS (${choices}) SELECT EXISTS (SELECT 1 FROM allowed) AND ${invalid})`});
    }
    return checks;
  });
}
