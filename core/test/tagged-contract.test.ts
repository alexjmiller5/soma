import { expect, test } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateContract } from '../../scripts/generate-core-contract.ts';
import contract from '../contract/core.json';

const fixture = () => ({ $defs: {
  Empty: { type: 'object', properties: { kind: { type: 'string', enum: ['empty'] } }, required: ['kind'] },
  Text: { type: 'object', properties: { kind: { type: 'string', enum: ['text'] }, value: { type: 'string' } }, required: ['kind', 'value'] },
  Cell: { oneOf: [{ $ref: '#/$defs/Empty' }, { $ref: '#/$defs/Text' }] },
}, operations: {} });

async function runCommand(args:string[],timeoutMs:number){
  const child=Bun.spawn(args,{stdout:'pipe',stderr:'pipe'});
  const timer=setTimeout(()=>child.kill(),timeoutMs);
  try{
    const [code,stdout,stderr]=await Promise.all([child.exited,
      new Response(child.stdout).text(),new Response(child.stderr).text()]);
    return {code,stdout,stderr};
  }finally{clearTimeout(timer);if(child.exitCode===null)child.kill();}
}

test('named tagged unions preserve discriminant narrowing and reject mixed payloads in TypeScript', async () => {
  const output=generateContract(fixture());
  const dir=await mkdtemp(join(tmpdir(),'life-contract-union-'));
  try {
    await writeFile(join(dir,'types.ts'),output.typescript+`
const valid: Cell = {kind:'text',value:''};
const empty: Cell = {kind:'empty'};
// @ts-expect-error a text payload is required
const missing: Cell = {kind:'text'};
// @ts-expect-error an empty variant cannot carry text
const mixed: Cell = {kind:'empty',value:'hidden'};
function read(value: Cell): string { return value.kind==='text'?value.value:'empty'; }
`);
    // This standalone DTO fixture must not discover unrelated ambient packages.
    const result=await runCommand([resolve(import.meta.dir,'../node_modules/.bin/tsc'),'--noEmit','--strict','--skipLibCheck','--typeRoots',dir,join(dir,'types.ts')],30_000);
    expect(result).toEqual({code:0,stdout:'',stderr:''});
  } finally { await rm(dir,{recursive:true,force:true}); }
},45_000);

test.each(['repeated','optional','missing','inline','nonobject'])('ambiguous tagged union %s fails generation',kind=>{
  const contract:any=fixture();
  if(kind==='repeated')contract.$defs.Text.properties.kind.enum=['empty'];
  if(kind==='optional')contract.$defs.Text.required=['value'];
  if(kind==='missing')delete contract.$defs.Text.properties.kind;
  if(kind==='inline')contract.$defs.Cell.oneOf[0]=contract.$defs.Empty;
  if(kind==='nonobject')contract.$defs.Text.type='string';
  expect(()=>generateContract(contract)).toThrow(/unsupported schema/);
});

test.skipIf(!Bun.which('swiftc'))('Swift tagged codecs reject absent/unknown tags and mismatched encoded variants',async()=>{
  const output=generateContract(fixture());
  const dir=await mkdtemp(join(tmpdir(),'life-contract-swift-'));
  try {
    await writeFile(join(dir,'Contract.swift'),output.swift);
    await writeFile(join(dir,'main.swift'),`
import Foundation
let decoder=JSONDecoder(), encoder=JSONEncoder()
for json in [#"{"kind":"empty"}"#, #"{"kind":"text","value":""}"#] {
  let data=Data(json.utf8)
  let value=try decoder.decode(CoreCell.self,from:data)
  let roundtrip=try encoder.encode(value)
  let decoded=try decoder.decode(CoreCell.self,from:roundtrip)
  precondition(decoded==value)
}
for json in [#"{}"#, #"{"kind":"unknown"}"#, #"{"kind":"text"}"#, #"{"kind":false}"#] {
  precondition((try? decoder.decode(CoreCell.self,from:Data(json.utf8))) == nil)
}
precondition((try? encoder.encode(CoreCell.text(CoreText(kind:"empty",value:"hidden")))) == nil)
print("tagged codecs pass")
`);
    // Linux CI compiles Foundation into a cold private cache. Keep a generous
    // compile deadline separate from the tiny executable's runtime deadline.
    const compile=await runCommand(['swiftc','-module-cache-path',join(dir,'cache'),join(dir,'Contract.swift'),join(dir,'main.swift'),'-o',join(dir,'check')],150_000);
    expect(compile).toEqual({code:0,stdout:'',stderr:''});
    const run=await runCommand([join(dir,'check')],5_000);
    expect(run).toEqual({code:0,stdout:'tagged codecs pass\n',stderr:''});
  } finally { await rm(dir,{recursive:true,force:true}); }
},180_000);

test.skipIf(!Bun.which('swiftc'))('governance error codecs require original-operation resolution on the wire',async()=>{
  const names=['MutationErrorCode','MutationResolution','ConflictCode','Conflict','MutationError'];
  const definitions=contract.$defs as Parameters<typeof generateContract>[0]['$defs'];
  const output=generateContract({$defs:Object.fromEntries(names.filter(name=>definitions[name]).map(name=>[name,definitions[name]])),operations:{}});
  const dir=await mkdtemp(join(tmpdir(),'life-governance-resolution-'));
  try {
    await writeFile(join(dir,'Contract.swift'),output.swift);
    await writeFile(join(dir,'main.swift'),`
import Foundation
let decoder=JSONDecoder(), encoder=JSONEncoder()
for resolution in ["unresolved", "not_committed"] {
  let data=try JSONSerialization.data(withJSONObject:["kind":"error", "code":"revision_changed", "conflicts":[], "resolution":resolution])
  let value=try decoder.decode(CoreMutationError.self,from:data)
  let encoded=try encoder.encode(value)
  let object=try JSONSerialization.jsonObject(with:encoded) as! [String:Any]
  precondition(object["resolution"] as? String == resolution)
}
for json in [#"{"kind":"error","code":"unavailable","conflicts":[]}"#,
             #"{"kind":"error","code":"unavailable","conflicts":[],"resolution":"committed"}"#,
             #"{"kind":"error","code":"unavailable","conflicts":[],"resolution":null}"#] {
  precondition((try? decoder.decode(CoreMutationError.self,from:Data(json.utf8))) == nil)
}
print("governance resolution codecs pass")
`);
    const compile=await runCommand(['swiftc','-module-cache-path',join(dir,'cache'),join(dir,'Contract.swift'),join(dir,'main.swift'),'-o',join(dir,'check')],150_000);
    expect(compile).toEqual({code:0,stdout:'',stderr:''});
    const run=await runCommand([join(dir,'check')],5_000);
    expect(run).toEqual({code:0,stdout:'governance resolution codecs pass\n',stderr:''});
  } finally { await rm(dir,{recursive:true,force:true}); }
},180_000);
