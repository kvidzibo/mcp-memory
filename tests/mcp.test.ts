import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const cli = fileURLToPath(new URL('../src/cli.js',import.meta.url));

test('real stdio clients exercise strict tools, concurrent writers, retrieval statistics and persistence', async t => {
  const directory = mkdtempSync(join(tmpdir(),'mcp-memory-protocol-'));
  const workspace = join(directory,'project'); mkdirSync(workspace);
  const clients: Client[] = [];
  t.after(async () => { await Promise.all(clients.map(client => client.close())); rmSync(directory,{ recursive: true,force: true }); });
  const connect = async (extra: string[] = []) => {
    const client = new Client({ name: 'memory-test',version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [cli,'--db',join(directory,'memory.sqlite3'),'--workspace',workspace,...extra],stderr: 'pipe' });
    clients.push(client); await client.connect(transport); return client;
  };
  const call = async (client: Client,name: string,args: Record<string,unknown>) => {
    const result = await client.callTool({ name,arguments: args });
    assert.notEqual(result.isError,true,JSON.stringify(result));
    return result.structuredContent as Record<string,any>;
  };
  const [first,second] = await Promise.all([
    connect(['--allow-write','--client','test-a']),
    connect(['--allow-write','--client','test-b']),
  ]);
  assert.deepEqual((await first.listTools()).tools.map(tool => tool.name).sort(),[
    'memory_add','memory_archive','memory_feedback','memory_get','memory_search','memory_supersede',
  ]);
  const input = { text: 'Run the package tests with npm test.',evidence: [{ description: 'Verified by executing the test command.' }] };
  const additions = await Promise.all([call(first,'memory_add',input),call(second,'memory_add',input)]);
  assert.equal(additions[0]!.memory.id,additions[1]!.memory.id);
  assert.equal(additions.filter(result => result.created).length,1);
  const id = additions[0]!.memory.id;
  const deliveries = await Promise.all([call(first,'memory_get',{ id }),call(second,'memory_get',{ id })]);
  assert.notEqual(deliveries[0]!.request_id,deliveries[1]!.request_id);
  const search = await call(first,'memory_search',{ query: 'running tests' });
  assert.equal(search.results[0].retrieval_count,3);
  await call(first,'memory_feedback',{ memory_id: id,verdict: 'useful',reason: 'Saved investigation.' });
  const readOnly = await connect();
  assert.equal((await readOnly.callTool({ name: 'memory_add',arguments: input })).isError,true);
  assert.equal((await call(readOnly,'memory_get',{ id })).useful_count,1);
  assert.equal((await first.callTool({ name: 'memory_get',arguments: { id,scope: 'global' } })).isError,true);
  assert.equal((await first.callTool({ name: 'memory_get',arguments: { id: String(id) } })).isError,true);
  assert.equal((await first.callTool({ name: 'memory_add',arguments: { ...input,scope: 'global' } })).isError,true);
  const replacement = await call(first,'memory_supersede',{ id,text: 'Run the full validation suite with npm test.',evidence: input.evidence });
  assert.equal(replacement.supersedes_id,id);
  await call(first,'memory_archive',{ id: replacement.id });
  assert.equal((await call(first,'memory_search',{ query: 'validation tests' })).results.length,0);
  const archived = await call(readOnly,'memory_get',{ id });
  assert.equal(archived.status,'archived');
  assert.equal(archived.source_client === 'test-a' || archived.source_client === 'test-b',true);
});

test('CLI help is standalone and invalid startup options fail without protocol noise', () => {
  const help = execFileSync(process.execPath,[cli,'--help'],{ encoding: 'utf8' });
  assert.match(help,/--allow-model-download/);
  assert.match(help,/--embedding-revision/);
  assert.throws(() => execFileSync(process.execPath,[cli,'--allow-global-write'],{ stdio: 'pipe' }),error => {
    const result = error as { stdout: Buffer; stderr: Buffer };
    assert.equal(result.stdout.toString(),'');
    assert.match(result.stderr.toString(),/Global writes require/); return true;
  });
});
