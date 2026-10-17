import { createHash } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { basename, dirname, isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { APPLICATION_ID, SCHEMA, SCHEMA_VERSION } from './schema.js';
import {
  addSchema, archiveSchema, feedbackSchema, idSchema, supersedeSchema, InputError,
  type AddInput, type Evidence, type Memory, type Statistics, type StoreOptions,
} from './types.js';
import { validateVector } from './embeddings.js';

type Row = Record<string, unknown>;
export const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export const embeddingContent = (memory: Memory) => [memory.text, ...memory.evidence.map(item => item.description)].join('\n');
const normalizedHash = (text: string) => hash(text.normalize('NFKC').replace(/\s+/gu,' ').trim());

/** Every public ID operation checks launch-bound scopes before revealing content. */
export class MemoryStore {
  private readonly db: DatabaseSync;
  readonly projectId: number;
  readonly globalId: number;
  private closed = false;

  constructor(readonly options: StoreOptions) {
    if (!isAbsolute(options.database) || !isAbsolute(options.project)) throw new Error('Database and project paths must be absolute');
    mkdirSync(dirname(options.database), { recursive: true, mode: 0o700 });
    try { closeSync(openSync(options.database, 'wx', 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if (!lstatSync(options.database).isFile()) throw new Error('Database must be a regular file, not a symlink');
    this.db = new DatabaseSync(options.database);
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
      this.transaction(() => {
        const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
        const application = Number(this.db.prepare('PRAGMA application_id').get()!.application_id);
        const empty = this.db.prepare("SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get() === undefined;
        if (empty && version === 0 && application === 0) {
          this.db.exec(SCHEMA);
          this.db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${SCHEMA_VERSION};`);
        } else if (version !== SCHEMA_VERSION || application !== APPLICATION_ID) {
          throw new Error('Unsupported or foreign database; choose a fresh database (no automatic migration)');
        }
      });
      const mode = this.db.prepare('PRAGMA journal_mode=WAL').get()!.journal_mode;
      if (mode !== 'wal') throw new Error('A local filesystem with SQLite WAL support is required');
      this.db.exec('PRAGMA synchronous=FULL;');
      [this.projectId, this.globalId] = this.transaction(() => {
        const now = Date.now();
        this.db.prepare("INSERT OR IGNORE INTO scopes(kind,name,project_path,created_at) VALUES('project',?,?,?)")
          .run(basename(options.project) || options.project, options.project, now);
        this.db.prepare("INSERT OR IGNORE INTO scopes(kind,name,project_path,created_at) VALUES('global','Global',NULL,?)").run(now);
        return [
          Number(this.db.prepare("SELECT id FROM scopes WHERE kind='project' AND project_path=?").get(options.project)!.id),
          Number(this.db.prepare("SELECT id FROM scopes WHERE kind='global'").get()!.id),
        ];
      });
    } catch (error) { this.db.close(); throw error; }
  }

  close(): void { if (!this.closed) { this.closed = true; this.db.close(); } }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  private scopeIds(scope: 'project' | 'global' | 'all' = 'all'): number[] {
    if (scope === 'global') {
      if (!this.options.readGlobal) throw new InputError('Global access is disabled');
      return [this.globalId];
    }
    return scope === 'all' && this.options.readGlobal ? [this.projectId, this.globalId] : [this.projectId];
  }

  private assertWrite(scopeId: number): void {
    if (!this.options.allowWrite || (scopeId === this.globalId && !this.options.allowGlobalWrite)) {
      throw new InputError('Memory writes are not enabled for this scope');
    }
  }

  private read(id: number): Memory {
    idSchema.parse(id);
    const ids = this.scopeIds();
    const row = this.db.prepare(`SELECT m.*,s.kind AS scope FROM memories m JOIN scopes s ON s.id=m.scope_id
      WHERE m.id=? AND m.scope_id IN (${ids.map(() => '?').join(',')})`).get(id, ...ids);
    if (!row) throw new InputError('Memory not found in accessible scopes');
    const evidence = this.db.prepare('SELECT * FROM evidence WHERE memory_id=? ORDER BY id').all(id) as unknown as Evidence[];
    return { ...row, evidence } as unknown as Memory;
  }

  private event(id: number, action: string, reason?: string, details: object = {}): void {
    const origin = this.options.origin;
    this.db.prepare(`INSERT INTO events(memory_id,action,actor,source_client,source_session,reason,details_json,created_at)
      VALUES(?,?,'agent',?,?,?,?,?)`).run(id, action, origin.client, origin.session, reason ?? null, JSON.stringify(details), Date.now());
  }

  private insert(scopeId: number, input: AddInput, supersedes: number | null = null): Memory {
    const origin = this.options.origin;
    const now = Date.now();
    const result = this.db.prepare(`INSERT INTO memories(scope_id,text,text_hash,status,supersedes_id,source_client,source_session,source_model,created_at)
      VALUES(?,?,?,'active',?,?,?,?,?)`).run(scopeId,input.text,normalizedHash(input.text),supersedes,origin.client,origin.session,origin.model,now);
    const id = Number(result.lastInsertRowid);
    for (const item of input.evidence) {
      this.db.prepare('INSERT INTO evidence(memory_id,description,source_uri,created_at) VALUES(?,?,?,?)')
        .run(id,item.description,item.source_uri ?? null,now);
    }
    this.db.prepare('INSERT INTO memory_search_index(memory_id,memory_text,evidence_text) VALUES(?,?,?)')
      .run(id,input.text,input.evidence.map(item => item.description).join('\n'));
    this.event(id,'created',input.reason,supersedes === null ? {} : { supersedes_id: supersedes });
    return this.read(id);
  }

  add(raw: unknown): { memory: Memory; created: boolean } {
    const input = addSchema.parse(raw);
    const scopeId = input.scope === 'global' ? this.globalId : this.projectId;
    if (input.scope === 'global' && !this.options.readGlobal) throw new InputError('Global access is disabled');
    this.assertWrite(scopeId);
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT id FROM memories WHERE scope_id=? AND text_hash=? AND status='active'")
        .get(scopeId,normalizedHash(input.text));
      if (existing) return { memory: this.read(Number(existing.id)), created: false };
      return { memory: this.insert(scopeId,input), created: true };
    });
  }

  supersede(raw: unknown): Memory {
    const input = supersedeSchema.parse(raw);
    return this.transaction(() => {
      const previous = this.read(input.id);
      this.assertWrite(previous.scope_id);
      if (previous.status !== 'active') throw new InputError('Only active memories can be superseded');
      if (normalizedHash(input.text) === previous.text_hash) throw new InputError('Replacement text must differ from the original');
      const duplicate = this.db.prepare("SELECT id FROM memories WHERE scope_id=? AND text_hash=? AND status='active'")
        .get(previous.scope_id,normalizedHash(input.text));
      if (duplicate) throw new InputError('Replacement duplicates another active memory');
      this.db.prepare("UPDATE memories SET status='archived',archived_at=? WHERE id=?").run(Date.now(),previous.id);
      const replacement = this.insert(previous.scope_id,{ ...input, scope: previous.scope },previous.id);
      this.event(previous.id,'superseded',input.reason,{ replacement_id: replacement.id });
      return replacement;
    });
  }

  archive(raw: unknown): { id: number; changed: boolean } {
    const input = archiveSchema.parse(raw);
    return this.transaction(() => {
      const memory = this.read(input.id);
      this.assertWrite(memory.scope_id);
      if (memory.status === 'archived') return { id: memory.id, changed: false };
      this.db.prepare("UPDATE memories SET status='archived',archived_at=? WHERE id=?").run(Date.now(),memory.id);
      this.event(memory.id,'archived',input.reason);
      return { id: memory.id, changed: true };
    });
  }

  feedback(raw: unknown): { id: number; memory_id: number } {
    const input = feedbackSchema.parse(raw);
    // Feedback and delivery telemetry are allowed even when lesson mutations are disabled.
    this.read(input.memory_id);
    const result = this.db.prepare(`INSERT INTO memory_feedback(memory_id,verdict,reason,source_client,source_model,created_at)
      VALUES(?,?,?,?,?,?)`).run(input.memory_id,input.verdict,input.reason ?? null,this.options.origin.client,this.options.origin.model,Date.now());
    return { id: Number(result.lastInsertRowid), memory_id: input.memory_id };
  }

  stats(id: number): Statistics {
    this.read(id);
    const retrievals = this.db.prepare('SELECT count(*) AS retrieval_count,max(retrieved_at) AS last_retrieved_at FROM memory_retrievals WHERE memory_id=?').get(id)!;
    const feedback = this.db.prepare(`SELECT
      count(CASE WHEN verdict='useful' THEN 1 END) AS useful_count,
      count(CASE WHEN verdict='not_useful' THEN 1 END) AS not_useful_count,
      count(CASE WHEN verdict='incorrect' THEN 1 END) AS incorrect_count,
      count(CASE WHEN verdict='outdated' THEN 1 END) AS outdated_count,
      max(created_at) AS last_feedback_at FROM memory_feedback WHERE memory_id=?`).get(id)!;
    return { ...retrievals, ...feedback } as unknown as Statistics;
  }

  /** Called only for content selected for a tool response, never metadata-only inspection. */
  recordRetrieval(ids: number[], method: 'search' | 'get' | 'recall'): number | null {
    if (!ids.length) return null;
    return this.transaction(() => {
      for (const id of ids) this.read(id);
      const requestId = Number(this.db.prepare('SELECT coalesce(max(request_id),0)+1 AS id FROM memory_retrievals').get()!.id);
      const statement = this.db.prepare('INSERT OR IGNORE INTO memory_retrievals(memory_id,request_id,method,retrieved_at) VALUES(?,?,?,?)');
      const now = Date.now();
      for (const id of new Set(ids)) statement.run(id,requestId,method,now);
      return requestId;
    });
  }

  get(id: number): Memory & Statistics & { history: Row[]; feedback: Row[] } {
    const memory = this.read(id);
    return {
      ...memory, ...this.stats(id),
      history: this.db.prepare('SELECT * FROM events WHERE memory_id=? ORDER BY id DESC LIMIT 20').all(id),
      feedback: this.db.prepare('SELECT * FROM memory_feedback WHERE memory_id=? ORDER BY id DESC LIMIT 10').all(id),
    };
  }

  keywordIds(query: string, scope: 'project' | 'global' | 'all', limit = 100): number[] {
    const ids = this.scopeIds(scope);
    const words = query.match(/[\p{L}\p{N}]+/gu)?.slice(0,32) ?? [];
    if (!words.length) return [];
    const match = words.map(word => `"${word}"`).join(' OR ');
    return this.db.prepare(`SELECT m.id FROM memory_search_index f JOIN memories m ON m.id=f.memory_id
      WHERE memory_search_index MATCH ? AND m.status='active' AND m.scope_id IN (${ids.map(() => '?').join(',')})
      ORDER BY bm25(memory_search_index,0,4,1),m.id LIMIT ?`).all(match,...ids,limit).map(row => Number(row.id));
  }

  /** Metadata-only snapshot: never loads lesson content or records a retrieval. */
  counts(): { project: number; global: number | null } {
    const ids = this.scopeIds();
    const rows = this.db.prepare(`SELECT scope_id,count(*) AS total FROM memories
      WHERE status='active' AND scope_id IN (${ids.map(() => '?').join(',')}) GROUP BY scope_id`).all(...ids);
    const count = (id: number) => Number(rows.find(row => row.scope_id === id)?.total ?? 0);
    return { project: count(this.projectId), global: this.options.readGlobal ? count(this.globalId) : null };
  }

  active(scope: 'project' | 'global' | 'all'): Memory[] {
    const ids = this.scopeIds(scope);
    return this.db.prepare(`SELECT id FROM memories WHERE status='active' AND scope_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`)
      .all(...ids).map(row => this.read(Number(row.id)));
  }

  embedding(memory: Memory, model: string): number[] | null {
    this.read(memory.id);
    const row = this.db.prepare('SELECT vector,dimensions,content_hash FROM memory_embeddings WHERE memory_id=? AND model=?').get(memory.id,model);
    if (!row || row.content_hash !== hash(embeddingContent(memory))) return null;
    const bytes = row.vector as Uint8Array;
    const view = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    return validateVector(Array.from({ length: Number(row.dimensions) },(_,index) => view.getFloat32(index*4,true)));
  }

  saveEmbedding(memory: Memory, model: string, values: readonly number[]): void {
    this.read(memory.id);
    const vector = validateVector(values);
    const bytes = Buffer.alloc(vector.length*4);
    vector.forEach((value,index) => bytes.writeFloatLE(value,index*4));
    this.db.prepare(`INSERT INTO memory_embeddings(memory_id,model,dimensions,vector,content_hash,created_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(memory_id,model) DO UPDATE SET dimensions=excluded.dimensions,vector=excluded.vector,content_hash=excluded.content_hash,created_at=excluded.created_at`)
      .run(memory.id,model,vector.length,bytes,hash(embeddingContent(memory)),Date.now());
  }
}
