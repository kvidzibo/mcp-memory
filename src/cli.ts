#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer, VERSION } from './server.js';
import { MemoryStore } from './store.js';
import { MemoryService } from './service.js';
import { createLocalEmbedder, DEFAULT_EMBEDDING_MODEL, DEFAULT_EMBEDDING_REVISION } from './embeddings.js';
import { projectPath } from './project.js';
import { backupDatabase } from './backup.js';

const HELP = `mcp-memory ${VERSION} — local-first SQLite memory over MCP stdio

Usage: mcp-memory [serve] [options]
       mcp-memory backup --db /path/memory.sqlite3 --output /existing/folder/backup.sqlite3

  --db PATH                 Database path (default: XDG data home/mcp-memory/memory.sqlite3)
  --workspace PATH          Bind project scope (default: current directory)
  --client NAME             Trusted client attribution (default: unknown)
  --session ID              Optional host-provided session attribution
  --model NAME              Optional host-provided agent model attribution
  --allow-write             Enable immediate project lesson mutations
  --allow-global-write      Also permit global mutations (requires --allow-write)
  --no-global-read          Exclude global memory
  --embeddings MODE         keyword (default) or local
  --embedding-model NAME    Default: Xenova/bge-small-en-v1.5
  --embedding-revision SHA  Immutable model commit (required for custom models)
  --embedding-cache PATH    Optional model cache directory
  --allow-model-download    Explicitly permit model downloads (local mode only)
  --help                    Show help
  --version                 Show version

Lesson writes are disabled by default; delivery counts and feedback still write telemetry.
No active assistant configuration is changed. Diagnostics use stderr; stdout is MCP-only.
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: {
    db: { type: 'string' }, workspace: { type: 'string' }, client: { type: 'string' },
    session: { type: 'string' }, model: { type: 'string' },
    'allow-write': { type: 'boolean', default: false }, 'allow-global-write': { type: 'boolean', default: false },
    'no-global-read': { type: 'boolean', default: false }, embeddings: { type: 'string', default: 'keyword' },
    'embedding-model': { type: 'string', default: DEFAULT_EMBEDDING_MODEL },
    'embedding-revision': { type: 'string' },
    'embedding-cache': { type: 'string' }, 'allow-model-download': { type: 'boolean', default: false },
    output: { type: 'string' }, help: { type: 'boolean' }, version: { type: 'boolean' },
  } });
  if (values.help) { process.stdout.write(HELP); return; }
  if (values.version) { process.stdout.write(`${VERSION}\n`); return; }
  const command = positionals[0] ?? 'serve';
  if (!['serve','backup'].includes(command) || positionals.length > 1) throw new Error('Unknown command; use --help');
  const dataHome = process.env.XDG_DATA_HOME && isAbsolute(process.env.XDG_DATA_HOME)
    ? process.env.XDG_DATA_HOME : resolve(homedir(),'.local','share');
  const database = resolve(values.db ?? resolve(dataHome,'mcp-memory','memory.sqlite3'));
  if (command === 'backup') {
    if (!values.db || !values.output) throw new Error('Backup requires --db and --output');
    await backupDatabase(database,resolve(values.output));
    process.stderr.write('Backup created and integrity checked.\n'); return;
  }
  if (values.output) throw new Error('--output is only valid for backup');
  if (!['keyword','local'].includes(values.embeddings)) throw new Error('--embeddings must be keyword or local');
  if (values['allow-model-download'] && values.embeddings !== 'local') throw new Error('Model downloads require --embeddings local');
  if (values['allow-global-write'] && (!values['allow-write'] || values['no-global-read'])) {
    throw new Error('Global writes require --allow-write and global reads');
  }
  const attribution = (value: string | undefined): string | null => {
    if (value === undefined) return null;
    if (!value.trim() || Buffer.byteLength(value,'utf8') > 200 || /[\x00-\x1f\x7f]/u.test(value)) throw new Error('Invalid host attribution');
    return value;
  };
  const revision = values['embedding-revision'] ?? (values['embedding-model'] === DEFAULT_EMBEDDING_MODEL ? DEFAULT_EMBEDDING_REVISION : undefined);
  if (values.embeddings === 'local' && (!revision || !/^[a-f0-9]{40}$/u.test(revision))) {
    throw new Error('Local embeddings require an immutable 40-character model revision SHA');
  }
  const store = new MemoryStore({ database, project: projectPath(values.workspace ?? process.cwd()),
    origin: { client: attribution(values.client) ?? 'unknown', session: attribution(values.session), model: attribution(values.model) },
    allowWrite: values['allow-write'], allowGlobalWrite: values['allow-global-write'], readGlobal: !values['no-global-read'],
  });
  const service = new MemoryService(store,values.embeddings === 'local' ? () => createLocalEmbedder({
    model: values['embedding-model'], revision: revision!, cacheDir: values['embedding-cache'] ? resolve(values['embedding-cache']) : undefined,
    allowDownload: values['allow-model-download'],
  }) : undefined);
  const server = createServer(service);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await server.close(); store.close();
  };
  server.server.onclose = () => { store.close(); };
  for (const event of ['SIGINT','SIGTERM'] as const) process.once(event,() => { void close().then(() => process.exit(0)); });
  process.stdin.once('end',() => { void close(); });
  try { await server.connect(new StdioServerTransport()); }
  catch (error) { store.close(); throw error; }
}

main().catch(error => { process.stderr.write(`mcp-memory: ${error instanceof Error ? error.message : 'Startup failed'}\n`); process.exitCode = 1; });
