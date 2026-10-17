import { type Embedder, cosineSimilarity, validateVector } from './embeddings.js';
import { MemoryStore, embeddingContent } from './store.js';
import { getSchema, searchSchema, type Memory, type Statistics } from './types.js';

import { MAX_RESPONSE_BYTES, responseBytes } from './response.js';
export { MAX_RESPONSE_BYTES } from './response.js';

/** Keyword relevance and semantic relevance have different scales; fuse their ranks. */
export function fuseRanks(lists: number[][]): number[] {
  const scores = new Map<number,number>();
  for (const list of lists) {
    [...new Set(list)].forEach((id,index) => scores.set(id,(scores.get(id) ?? 0)+1/(60+index+1)));
  }
  return [...scores].sort((a,b) => b[1]-a[1] || a[0]-b[0]).map(([id]) => id);
}

export class MemoryService {
  private embedder?: Promise<Embedder>;
  private queue: Promise<void> = Promise.resolve();

  constructor(readonly store: MemoryStore, private readonly embeddingFactory?: () => Promise<Embedder>) {}

  /** Serialize embedding work: local pipelines and first-use indexing are not re-entrant. */
  private async semantic(query: string, scope: 'project' | 'global' | 'all', signal?: AbortSignal): Promise<number[]> {
    const job = this.queue.then(async () => {
      signal?.throwIfAborted();
      this.embedder ??= this.embeddingFactory!();
      const embedder = await this.embedder;
      const queryVector = validateVector(await embedder.embed(query,'query'));
      const ranked: { id: number; score: number }[] = [];
      for (const memory of this.store.active(scope)) {
        signal?.throwIfAborted();
        let vector = this.store.embedding(memory,embedder.model);
        if (!vector) {
          vector = validateVector(await embedder.embed(embeddingContent(memory),'document'));
          this.store.saveEmbedding(memory,embedder.model,vector);
        }
        ranked.push({ id: memory.id, score: cosineSimilarity(queryVector,vector) });
      }
      signal?.throwIfAborted();
      return ranked.sort((a,b) => b.score-a.score || a.id-b.id).slice(0,100).map(item => item.id);
    });
    this.queue = job.then(() => undefined,() => undefined);
    return job;
  }

  async search(raw: unknown, signal?: AbortSignal) {
    const input = searchSchema.parse(raw);
    signal?.throwIfAborted();
    const keyword = this.store.keywordIds(input.query,input.scope);
    let ranked = keyword;
    let mode: 'keyword' | 'hybrid' = 'keyword';
    let warning: string | undefined;
    if (this.embeddingFactory) {
      try { ranked = fuseRanks([keyword,await this.semantic(input.query,input.scope,signal)]); mode = 'hybrid'; }
      catch {
        signal?.throwIfAborted();
        warning = 'Semantic search unavailable; keyword search used. Check the optional runtime/model configuration and restart to retry model loading.';
      }
    }
    signal?.throwIfAborted();
    const results: (Memory & Statistics)[] = [];
    let truncated = false;
    for (const id of ranked) {
      const { history: _history, feedback: _feedback, ...memory } = this.store.get(id);
      // A different process can archive a memory while embeddings are being computed.
      if (memory.status !== 'active') continue;
      if (results.length >= input.limit) { truncated = true; break; }
      if (responseBytes({ mode,warning,results: [...results,memory],truncated: true,request_id: Number.MAX_SAFE_INTEGER }) > MAX_RESPONSE_BYTES-2048) {
        truncated = true; break;
      }
      results.push(memory);
    }
    signal?.throwIfAborted();
    const requestId = this.store.recordRetrieval(results.map(memory => memory.id),'search');
    // Statistics include this delivery. History/feedback remain scoped to each returned ID.
    for (const memory of results) Object.assign(memory,this.store.stats(memory.id));
    return { mode, ...(warning ? { warning } : {}), results, truncated, request_id: requestId };
  }

  get(raw: unknown) {
    const { id } = getSchema.parse(raw);
    const memory = this.store.get(id);
    let truncated = false;
    while (responseBytes({ ...memory,truncated: true,request_id: Number.MAX_SAFE_INTEGER }) > MAX_RESPONSE_BYTES-2048) {
      if (memory.feedback.length) memory.feedback.pop();
      else if (memory.history.length) memory.history.pop();
      else throw new Error('Memory exceeds the output budget');
      truncated = true;
    }
    const requestId = this.store.recordRetrieval([id],'get');
    return { ...memory, ...this.store.stats(id), request_id: requestId, truncated };
  }
}
