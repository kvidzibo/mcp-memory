export interface Embedder {
  readonly model: string;
  embed(text: string, kind: 'query' | 'document'): Promise<number[]>;
}

export function validateVector(values: readonly number[]): number[] {
  if (!values.length || values.length > 16384 || values.some(value => !Number.isFinite(value) || Math.abs(value) > 3.4e38)) {
    throw new Error('Invalid embedding vector');
  }
  const norm = Math.hypot(...values);
  if (!Number.isFinite(norm) || norm === 0) throw new Error('Embedding vector must have a finite nonzero norm');
  return [...values];
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  validateVector(a); validateVector(b);
  if (a.length !== b.length) throw new Error('Embedding dimensions do not match');
  const na = Math.hypot(...a), nb = Math.hypot(...b);
  const score = a.reduce((sum,value,index) => sum + (value/na)*(b[index]!/nb),0);
  return Math.max(-1,Math.min(1,score));
}

export const DEFAULT_EMBEDDING_MODEL = 'Xenova/bge-small-en-v1.5';
export const DEFAULT_EMBEDDING_REVISION = 'ea104dacec62c0de699686887e3f920caeb4f3e3';

export async function createLocalEmbedder(options: {
  model: string; revision: string; cacheDir?: string; allowDownload: boolean;
}): Promise<Embedder> {
  if (!/^[a-f0-9]{40}$/u.test(options.revision)) throw new Error('Embedding revision must be an immutable model commit SHA');
  // Optional peer dependency: keyword mode never imports or installs this runtime.
  const packageName = '@huggingface/transformers';
  const { pipeline, env } = await import(packageName);
  env.allowRemoteModels = options.allowDownload;
  if (options.cacheDir) env.cacheDir = options.cacheDir;
  const extractor = await pipeline('feature-extraction',options.model, { revision: options.revision, dtype: 'q8', device: 'cpu' });
  return {
    model: `${options.model}@${options.revision}:q8:mean:normalize:v1`,
    async embed(text,kind) {
      const input = kind === 'query' && /bge/i.test(options.model)
        ? `Represent this sentence for searching relevant passages: ${text}` : text;
      const output = await extractor(input, { pooling: 'mean', normalize: true });
      return validateVector(Array.from(output.data as ArrayLike<number>));
    },
  };
}
