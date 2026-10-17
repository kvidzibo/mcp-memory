import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { MemoryStore } from '../src/store.js';
import { MemoryService } from '../src/service.js';
import { z } from 'zod';
import { MEMORY_URI, UI_MIME } from '../src/native-ui.js';

const cli = fileURLToPath(new URL('../src/cli.js',import.meta.url));
const changed = z.object({ method: z.literal('notifications/native-ui/changed'),params: z.object({ uri: z.string() }) });

test('native memory footer counts active accessible scopes without retrievals and honors gateway workspace', { timeout: 20_000 },async t => {
  const directory = mkdtempSync(join(tmpdir(),'memory-footer-'));
  const workspace = join(directory,'project'); mkdirSync(workspace);
  const other = join(directory,'other'); mkdirSync(other);
  const database = join(directory,'memory.sqlite3');
  const clients: Client[] = [];
  const stores: MemoryStore[] = [];
  t.after(async () => { await Promise.all(clients.map(client => client.close())); stores.forEach(store => store.close()); rmSync(directory,{ recursive: true,force: true }); });
  const connect = async (args: string[] = []) => {
    const client = new Client({ name: 'footer-test',version: '1' }); clients.push(client);
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [cli,'--db',database,...args],cwd: directory,env: { MCP_GATEWAY_WORKSPACE: workspace },stderr: 'pipe' }));
    return client;
  };
  const first = await connect(['--allow-write','--allow-global-write']);
  const hidden = await connect(['--no-global-read']);
  const second = await connect(['--workspace',other,'--allow-write']);
  const changes: string[] = [];
  first.setNotificationHandler(changed,notification => { changes.push(notification.params.uri); });
  assert.ok(first.getServerCapabilities()?.experimental?.['native-ui-v1']);
  const resources = (await first.listResources()).resources;
  assert.equal(resources.length,1); assert.equal(resources[0]!.mimeType,UI_MIME);
  const read = async (client = first) => {
    const result = await client.readResource({ uri: MEMORY_URI });
    return JSON.parse((result.contents[0] as { text: string }).text);
  };
  const call = async (client: Client,name: string,args: Record<string,unknown>) => {
    const result = await client.callTool({ name,arguments: args });
    assert.notEqual(result.isError,true,JSON.stringify(result));
    return result.structuredContent as Record<string,any>;
  };
  const input = { text: 'Use the local validation command.',evidence: [{ description: 'Checked in the package manifest.' }] };
  assert.equal((await read()).footer[0].text,'🧠 0|0');
  const added = await call(first,'memory_add',input);
  await call(first,'memory_add',input); // Duplicate is not another memory.
  await call(first,'memory_add',{ ...input,scope: 'global' });
  await call(second,'memory_add',input);
  assert.ok(changes.includes(MEMORY_URI));
  const original = await read();
  assert.equal(original.footer[0].text,'🧠 1|1');
  assert.ok(original.body.includes(JSON.stringify(workspace)),'Gateway project wins over child cwd');
  assert.ok((await read(second)).body.includes(JSON.stringify(other)),'Explicit CLI workspace wins over gateway');
  const replacement = await call(first,'memory_supersede',{ ...input,id: added.memory.id,text: 'Use the revised validation command.' });
  assert.equal((await read()).footer[0].text,'🧠 1|1');
  await call(first,'memory_archive',{ id: replacement.id });
  assert.equal((await read()).footer[0].text,'🧠 0|1');
  const noGlobal = await read(hidden);
  assert.equal(noGlobal.footer[0].text,'🧠 0|-');
  assert.match(noGlobal.body,/disabled global/);
  const action = { uri: MEMORY_URI,revision: original.revision,action: 'details' };
  const details = await first.request({ method: 'native-ui/action',params: action },z.object({ view: z.any(),preview: z.string() }));
  assert.equal(details.view.footer[0].text,'🧠 0|1','Read-only details use fresh counts');
  assert.equal(details.preview,details.view.body);
  for (const bad of [{ ...action,uri: 'memory://elsewhere' },{ ...action,action: 'archive' },{ ...action,value: 1 }]) {
    await assert.rejects(first.request({ method: 'native-ui/action',params: bad },z.any()));
  }
  const store = new MemoryStore({ database,project: workspace,origin: { client: 'notification-test',session: null,model: null },allowWrite: true,allowGlobalWrite: false,readGlobal: true });
  stores.push(store);
  const server = createServer(new MemoryService(store));
  const [serverTransport,clientTransport] = InMemoryTransport.createLinkedPair();
  const local = new Client({ name: 'notification-test',version: '1' }); clients.push(local);
  await Promise.all([server.connect(serverTransport),local.connect(clientTransport)]);
  server.server.notification = async () => { throw new Error('Injected notification transport failure'); };
  await call(local,'memory_add',{ ...input,text: 'Keep committed writes successful if the UI disconnects.' });
  assert.equal((await read(local)).footer[0].text,'🧠 1|1','A failed UI notification does not roll back or misreport the save');
  const db = new DatabaseSync(database,{ readOnly: true });
  try { assert.equal(db.prepare('SELECT count(*) AS n FROM memory_retrievals').get()!.n,0); }
  finally { db.close(); }
});
