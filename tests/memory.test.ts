import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { MemoryStore } from '../src/store.js';
import { MemoryService, MAX_RESPONSE_BYTES } from '../src/service.js';
import { cosineSimilarity, validateVector } from '../src/embeddings.js';
import { projectPath } from '../src/project.js';
import { backupDatabase } from '../src/backup.js';
import type { StoreOptions } from '../src/types.js';
import type { TestContext } from 'node:test';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(),'mcp-memory-test-'));
  const project = join(directory,'project'); mkdirSync(project);
  const database = join(directory,'memory.sqlite3');
  const stores: MemoryStore[] = [];
  const open = (changes: Partial<StoreOptions> = {}) => {
    const store = new MemoryStore({ database,project,origin: { client: 'test',session: null,model: null },
      allowWrite: true,allowGlobalWrite: false,readGlobal: true,...changes });
    stores.push(store); return store;
  };
  t.after(() => { stores.forEach(store => store.close()); rmSync(directory,{ recursive: true,force: true }); });
  return { directory,project,database,open };
}
const lesson = (text = 'Run validation with npm test.') => ({ text,evidence: [{ description: 'Verified in a clean local checkout.' }] });

test('keyword search finds text/evidence, records integer deliveries, and feedback survives restart', async t => {
  const f = fixture(t), store = f.open(), service = new MemoryService(store);
  const { memory } = store.add(lesson());
  assert.equal(Number.isSafeInteger(memory.id),true);
  assert.equal(store.add(lesson('Run   validation with npm test.')).created,false);
  assert.equal(store.stats(memory.id).retrieval_count,0);
  const found = await service.search({ query: 'running tests' });
  assert.deepEqual(found.results.map(item => item.id),[memory.id]);
  assert.equal(found.results[0]!.retrieval_count,1);
  assert.equal(Number.isSafeInteger(found.request_id),true);
  assert.equal((await service.search({ query: 'clean checkout' })).results[0]!.id,memory.id);
  const get = service.get({ id: memory.id });
  assert.equal(get.retrieval_count,3);
  assert.equal(get.request_id! > found.request_id!,true);
  store.feedback({ memory_id: memory.id,verdict: 'useful',reason: 'Identified the working validation command.' });
  store.close();
  const reopened = f.open();
  assert.equal(reopened.stats(memory.id).useful_count,1);
  assert.equal(reopened.stats(memory.id).retrieval_count,3);
  assert.equal(statSync(f.database).mode & 0o777,0o600);
});

test('launch permissions and scoped ID lookups prevent cross-project disclosure or mutation', async t => {
  const f = fixture(t), writer = f.open({ allowGlobalWrite: true });
  const privateMemory = writer.add(lesson('Private project build command.')).memory;
  const global = writer.add({ ...lesson('Shared global guidance.'),scope: 'global' }).memory;
  const otherPath = join(f.directory,'other'); mkdirSync(otherPath);
  const other = f.open({ project: otherPath,allowWrite: false });
  assert.throws(() => other.get(privateMemory.id),/not found/);
  assert.throws(() => other.feedback({ memory_id: privateMemory.id,verdict: 'useful' }),/not found/);
  assert.throws(() => other.archive({ id: privateMemory.id }),/not found/);
  assert.throws(() => other.add(lesson()),/not enabled/);
  assert.throws(() => other.supersede({ id: global.id,...lesson() }),/not enabled/);
  const result = await new MemoryService(other).search({ query: 'private shared' });
  assert.deepEqual(result.results.map(item => item.id),[global.id]);
  assert.equal(writer.stats(privateMemory.id).retrieval_count,0);
  assert.throws(() => f.open({ readGlobal: false }).get(global.id),/not found/);
  assert.throws(() => f.open().archive({ id: global.id }),/not enabled/);
});

test('supersede is atomic, preserves history/scope, and starts fresh statistics', async t => {
  const f = fixture(t), store = f.open(), service = new MemoryService(store);
  const old = store.add(lesson('Use the old validation command.')).memory;
  const duplicate = store.add(lesson('Use the new validation command.')).memory;
  service.get({ id: old.id });
  store.feedback({ memory_id: old.id,verdict: 'outdated' });
  assert.throws(() => store.supersede({ id: old.id,...lesson(duplicate.text) }),/duplicates/);
  assert.equal(store.get(old.id).status,'active');
  const replacement = store.supersede({ id: old.id,...lesson('Use the corrected verification command.'),reason: 'Validated replacement.' });
  assert.equal(replacement.scope_id,old.scope_id);
  assert.equal(replacement.supersedes_id,old.id);
  assert.equal(store.stats(replacement.id).retrieval_count,0);
  assert.equal(store.stats(replacement.id).outdated_count,0);
  assert.equal(store.get(old.id).status,'archived');
  assert.equal(store.get(old.id).history[0]!.action,'superseded');
  assert.equal((await service.search({ query: 'old' })).results.length,0);
  assert.throws(() => store.supersede({ id: old.id,...lesson('Another correction.') }),/Only active/);
  assert.equal(store.archive({ id: replacement.id }).changed,true);
  assert.equal(store.archive({ id: replacement.id }).changed,false);
  assert.equal((await service.search({ query: 'corrected' })).results.length,0);
});

test('schema rejects foreign databases and retains append-only history and integer keys', t => {
  const f = fixture(t), store = f.open();
  const memory = store.add(lesson()).memory;
  const direct = new DatabaseSync(f.database);
  try {
    assert.throws(() => direct.prepare('UPDATE memories SET text=? WHERE id=?').run('changed',memory.id),/immutable/);
    assert.throws(() => direct.prepare('DELETE FROM evidence WHERE memory_id=?').run(memory.id),/Append-only/);
    assert.throws(() => direct.prepare('DELETE FROM events WHERE memory_id=?').run(memory.id),/Append-only/);
    const tables = direct.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
    assert.equal(tables.includes('tasks'),false);
  } finally { direct.close(); }
  const foreignPath = join(f.directory,'foreign.sqlite3');
  const foreign = new DatabaseSync(foreignPath); foreign.exec('CREATE TABLE unrelated (id INTEGER)'); foreign.close();
  const before = readFileSync(foreignPath);
  assert.throws(() => f.open({ database: foreignPath }),/foreign database/);
  assert.deepEqual(readFileSync(foreignPath),before);
  const link = join(f.directory,'link.sqlite3'); symlinkSync(f.database,link);
  assert.throws(() => f.open({ database: link }),/regular file/);
});

test('hybrid search embeds only accessible memories, caches vectors, and falls back safely', async t => {
  const f = fixture(t), store = f.open();
  const target = store.add(lesson()).memory;
  const otherPath = join(f.directory,'other'); mkdirSync(otherPath);
  f.open({ project: otherPath }).add(lesson('Secret unrelated deployment instructions.'));
  const documents: string[] = [];
  const hybrid = new MemoryService(store,async () => ({
    model: 'test-vector-v1',
    async embed(text,kind) { if (kind === 'document') documents.push(text); return [1,0]; },
  }));
  const result = await hybrid.search({ query: 'execute verification' });
  assert.equal(result.mode,'hybrid');
  assert.equal(result.results[0]!.id,target.id);
  assert.equal(documents.length,1);
  assert.equal(documents[0]!.includes('Secret'),false);
  await hybrid.search({ query: 'verify changes' });
  assert.equal(documents.length,1);
  const fallback = new MemoryService(store,async () => { throw new Error('Missing optional runtime'); });
  const keyword = await fallback.search({ query: 'tests' });
  assert.equal(keyword.mode,'keyword');
  assert.match(keyword.warning!,/keyword search used/);
  assert.equal(keyword.results[0]!.id,target.id);
  const aborted = new AbortController(); aborted.abort();
  const count = store.stats(target.id).retrieval_count;
  await assert.rejects(hybrid.search({ query: 'tests' },aborted.signal));
  assert.equal(store.stats(target.id).retrieval_count,count);
});

test('vector comparison rejects invalid data and measures cosine similarity', () => {
  assert.equal(cosineSimilarity([1,0],[1,0]),1);
  assert.equal(cosineSimilarity([1,0],[0,1]),0);
  for (const invalid of [[],[0,0],[NaN],[Infinity],[1e100]]) assert.throws(() => validateVector(invalid));
  assert.throws(() => cosineSimilarity([1],[1,0]),/dimensions/);
});

test('search limits output, treats FTS syntax as text, and rejects malformed inputs', async t => {
  const f = fixture(t), store = f.open(), service = new MemoryService(store);
  for (let index=0;index<15;index++) store.add({ text: `Testing lesson ${index}: ${'x'.repeat(1900)}`,
    evidence: [{ description: 'y'.repeat(1000),source_uri: 'z'.repeat(2000) }] });
  const result = await service.search({ query: 'testing',limit: 50 });
  assert.equal(result.truncated,true);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= MAX_RESPONSE_BYTES);
  assert.equal(result.results.reduce((count,item) => count+item.retrieval_count,0),result.results.length);
  await service.search({ query: '" OR NEAR() * NOT' });
  await assert.rejects(service.search({ query: 'testing',limit: 999 }));
  assert.throws(() => store.add({ ...lesson(),project_path: '/other' }));
  assert.throws(() => store.feedback({ memory_id: 1,verdict: 'great' }));
});

test('online backup preserves WAL content, refuses overwrite, and can reopen independently', async t => {
  const f = fixture(t), store = f.open();
  const memory = store.add(lesson()).memory;
  const destination = join(f.directory,'backup.sqlite3');
  await backupDatabase(f.database,destination);
  assert.equal(statSync(destination).mode & 0o777,0o600);
  await assert.rejects(backupDatabase(f.database,destination));
  const restored = f.open({ database: destination });
  assert.equal(restored.get(memory.id).text,memory.text);
});

test('project identity shares linked worktrees while keeping submodules separate', t => {
  const directory = mkdtempSync(join(tmpdir(),'mcp-memory-git-'));
  t.after(() => rmSync(directory,{ recursive: true,force: true }));
  const main = join(directory,'main'), linked = join(directory,'linked'), child = join(directory,'child');
  const git = (args: string[],cwd = directory) => execFileSync('git',args,{ cwd,stdio: 'pipe' });
  git(['init',main]); git(['-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-m','Initial'],main);
  git(['worktree','add','-b','linked',linked],main);
  mkdirSync(join(linked,'nested'));
  assert.equal(projectPath(join(linked,'nested')),main);
  git(['init',child]); git(['-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-m','Initial'],child);
  git(['-c','protocol.file.allow=always','submodule','add',child,'child'],main);
  assert.equal(projectPath(join(main,'child')),join(main,'child'));
});
