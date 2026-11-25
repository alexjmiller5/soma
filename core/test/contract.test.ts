import { expect, test } from 'bun:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { generateContract } from '../../scripts/generate-core-contract.ts';

const root = resolve(import.meta.dir, '../..');
const contract = JSON.parse(await readFile(resolve(root, 'core/contract/core.json'), 'utf8'));

test('one contract deterministically generates TS and prefixed Swift, including operation pairs', () => {
  const first = generateContract(contract);
  expect(generateContract(JSON.parse(JSON.stringify(contract)))).toEqual(first);
  expect(first.typescript).toContain('export type View =');
  expect(first.typescript).toContain('export interface CoreOperations');
  expect(first.typescript).toContain('rows: { args: View; result: WorkspaceRow[] }');
  expect(first.typescript).toContain('referenceSources: { args: ReferenceSourcesArgs; result: ReferenceSource[] }');
  expect(first.typescript).toContain('referencedBy: { args: ReferencedByArgs; result: ReferencedByPage }');
  expect(first.swift).toContain('public typealias Response = CoreReferencedByPage');
  expect(first.typescript).toContain('search: { args: SearchArgs; result: SearchHit[] }');
  expect(first.typescript).toContain('remoteRows: { args: RemoteRowsArgs; result: RemoteRowsPage }');
  expect(first.typescript).toContain('remoteRow: { args: RemoteRowArgs; result: RemoteRowResult }');
  expect(first.swift).toContain('public init(record: CoreRow, label: String, deleted: Bool)');
  expect(first.swift).toContain('public init(endpoint: String, table: String, limit: CoreCount? = nil, cursor: String? = nil)');
  expect(first.swift).toContain('public init(rows: [CoreRemoteRecord], nextCursor: String?)');
  expect(first.swift).toContain('public typealias Response = CoreRemoteRowResult');
  expect(first.swift).toContain('public init(text: String, table: String? = nil, limit: CoreCount? = nil, offset: CoreCount? = nil)');
  expect(first.swift).toContain('public typealias Response = [CoreSearchHit]');
  expect(first.typescript).toContain('listViews: { args: ListViewsArgs; result: SavedViewList }');
  expect(first.typescript).toContain('saveView: { args: SaveViewArgs; result: SavedViewRecord }');
  expect(first.typescript).toContain('deleteView: { args: DeleteViewArgs; result: SavedViewRecord }');
  expect(first.typescript).toContain('writeability: { args: WriteabilityArgs; result: Writeability }');
  expect(first.swift).toContain('public typealias Response = CoreWriteability');
  expect(first.swift).toContain('public struct CoreSavedViewDefinition:');
  expect(first.swift).toContain('public typealias Response = CoreSavedViewList');
  expect(first.swift).toContain('public struct CoreView:');
  expect(first.swift).toContain('public struct CoreFilter:');
  expect(first.swift).toContain('public typealias Response = [CoreWorkspaceRow]');
  expect(first.swift).toContain('public enum CoreFilterOp: String');
  expect(first.swift).toContain('case notEmpty = "not_empty"');
  expect(first.typescript).toContain('undo: { args: UndoArgs; result: Row }');
  expect(first.typescript).toContain('undoStatus: { args: EmptyArgs; result: UndoStatus }');
  expect(first.typescript).toContain('rejections: { args: RejectionsArgs; result: RejectionsPage }');
  expect(first.swift).toContain('public init(table: String, rowID: String, submitted: CoreRow, errors: [CoreRow])');
  expect(first.swift).toContain('public init(rejections: [CoreRejectedEdit], nextOffset: CoreCount?)');
  expect(first.swift).toContain('public typealias Response = CoreRejectionsPage');
  expect(first.swift).toContain('public init(receiptId: String)');
  expect(first.swift).toContain('public init(action: CoreUndoAction?)');
  expect(first.swift).toContain('try container.encode(action, forKey: .action)');
  expect(first.typescript).toContain('enrollmentPollResult: { args: EnrollmentPollArgs; result: EnrollmentPollResult }');
  expect(first.swift).toContain('public init(reply: CoreSessionReply, expectedFingerprint: String, expectedProfile: CoreEnrollmentProfileExpectation? = nil)');
  expect(first.swift).toContain('public init(status: CoreCount, data: CoreJSONValue, retryAfterSeconds: CoreCount? = nil)');
  expect(first.swift).toContain('try container.encode(session, forKey: .session)');
  expect(first.hash).toMatch(/^[a-f0-9]{64}$/);
  expect(first.typescript).toContain(first.hash);
  expect(first.swift).toContain(first.hash);
  expect(first.swift).not.toContain('/Users/');
});

test('Swift codecs preserve required nulls, optional presence, and safe integers', () => {
  const { swift } = generateContract(contract);
  expect(swift).toContain('public enum CorePresence<Value:');
  expect(swift).toContain('try container.encode(readAt, forKey: .readAt)');
  expect(swift).toContain('try container.encode(nextCursor, forKey: .nextCursor)');
  expect(swift).toContain('container.contains(.readAt)');
  expect(swift).toContain('9_007_199_254_740_991');
  expect(swift).toContain('public init(column: String, op: CoreFilterOp, value: CoreFilterValue? = nil, relative: CoreFilterRelative? = nil)');
  expect(swift).toContain('public struct CoreCalendarContext:');
  expect(swift).toContain('public struct CoreFilterGroup:');
});

test('generated DTOs and requests carry projection and edit revision requirements', () => {
  const { swift, typescript } = generateContract(contract);
  for (const source of [swift, typescript]) {
    expect(source).toContain('columns is SQL projection');
    expect(source).toContain('fetch a full row before editing');
    expect(source).toContain('expectedUpdatedAt is required when id is supplied');
  }
});

test('unknown schema constructs and dangling operation types fail generation', () => {
  const bad = structuredClone(contract);
  bad.$defs.View.properties.table.pattern = 'secret';
  expect(() => generateContract(bad)).toThrow(/unsupported schema/);
  const missing = structuredClone(contract);
  missing.operations.rows.result = { $ref: '#/$defs/DoesNotExist' };
  expect(() => generateContract(missing)).toThrow(/unknown contract type/);
});

test('checked-in artifacts match the authoritative contract', async () => {
  const result = generateContract(contract);
  expect(await readFile(resolve(root, 'core/src/contract.generated.ts'), 'utf8')).toBe(result.typescript);
  expect(await readFile(resolve(root, 'core/generated/CoreContract.generated.swift'), 'utf8')).toBe(result.swift);
});

test('check mode detects stale output without rewriting either artifact', async () => {
  const temp = await mkdtemp(resolve(tmpdir(), 'core-contract-check-'));
  const ts = resolve(temp, 'core.ts'), swift = resolve(temp, 'core.swift');
  const generated = generateContract(contract);
  await writeFile(ts, generated.typescript);
  await writeFile(swift, generated.swift);
  const check = () => Bun.spawn(['bun', resolve(root, 'scripts/generate-core-contract.ts'), '--check', '--ts', ts, '--swift', swift], { stdout: 'pipe', stderr: 'pipe' });
  expect(await check().exited).toBe(0);
  await writeFile(swift, '// stale');
  expect(await check().exited).not.toBe(0);
  expect(await readFile(swift, 'utf8')).toBe('// stale');
  expect(await readFile(ts, 'utf8')).toBe(generated.typescript);
});

test.skipIf(!Bun.which('swiftc'))('generated governance capability compiles and round-trips its protocol wire key in Swift',async()=>{
  const {rm}=await import('node:fs/promises');
  const temp=await mkdtemp(resolve(tmpdir(),'core-swift-contract-'));
  try{
    const source=resolve(temp,'Core.swift'),main=resolve(temp,'main.swift'),executable=resolve(temp,'contract-check');
    await writeFile(source,generateContract(contract).swift);
    await writeFile(main,`import Foundation
let input = #"{"deploymentId":"deployment","sessionId":"session","protocol":"selected-inverse-proposals-v1","principal":{"principalId":"synthetic","kind":"user"},"authority":{"propose":true,"approve":true},"limits":{"maxSelectedEvents":100,"maxChangedColumns":64,"maxRequestBytes":65536,"maxPageSize":100,"previewTtlSeconds":300}}"#.data(using: .utf8)!
let capability = try JSONDecoder().decode(CoreGovernanceCapability.self, from: input)
precondition(capability.protocol == "selected-inverse-proposals-v1")
precondition(capability.deploymentId == "deployment" && capability.sessionId == "session")
let decoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(capability)) as! NSDictionary
let expected = try JSONSerialization.jsonObject(with: input) as! NSDictionary
precondition(decoded == expected)
let integer = try JSONDecoder().decode(CoreCreationOccurrenceKey.self, from: Data("2030".utf8))
guard case .integer(2030) = integer else { fatalError("integer occurrence changed kind") }
let encodedInteger = try JSONEncoder().encode(integer)
precondition(String(data: encodedInteger, encoding: .utf8) == "2030")
let string = try JSONDecoder().decode(CoreCreationOccurrenceKey.self, from: Data(#"\"2030\""#.utf8))
guard case .string("2030") = string else { fatalError("string occurrence changed kind") }
precondition((try? JSONDecoder().decode(CoreCreationOccurrenceKey.self, from: Data("1.5".utf8))) == nil)
precondition((try? JSONDecoder().decode(CoreCreationOccurrenceKey.self, from: Data("9007199254740992".utf8))) == nil)
precondition((try? JSONEncoder().encode(CoreCreationOccurrenceKey.integer(9_007_199_254_740_992))) == nil)
`);
    // Match the other Swift contract tests: cold Linux Foundation compilation
    // needs its own bounded deadline, longer than an ordinary unit test.
    const build=Bun.spawn(['swiftc','-module-cache-path',resolve(temp,'cache'),source,main,'-o',executable],{stdout:'pipe',stderr:'pipe'});
    const deadline=setTimeout(()=>build.kill(),150_000);
    try{
      const errors=await new Response(build.stderr).text();
      expect({code:await build.exited,errors}).toEqual({code:0,errors:''});
    }finally{
      clearTimeout(deadline);
      if(build.exitCode===null)build.kill();
    }
    expect(await Bun.spawn([executable],{stdout:'pipe',stderr:'pipe'}).exited).toBe(0);
  }finally{await rm(temp,{recursive:true,force:true});}
},180_000);

test('integer occurrence unions preserve numeric identity and enforce safe integer bounds',()=>{
  const {swift,typescript}=generateContract(contract);
  expect(typescript).toContain('export type CreationOccurrenceKey = string | number;');
  expect(swift).toContain('public enum CoreCreationOccurrenceKey:');
  expect(swift).toContain('case integer(Int)');
  expect(swift).toContain('if let value = try? container.decode(Int.self) { try CoreContract.checkInteger(value); self = .integer(value); return }');
  expect(swift).toContain('case .integer(let value): try CoreContract.checkInteger(value); try container.encode(value)');
});
