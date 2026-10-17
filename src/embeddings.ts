import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

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

interface Runtime {
  env: { allowRemoteModels: boolean; cacheDir: string };
  AutoTokenizer: { from_pretrained(model: string, options: object): Promise<unknown> };
  AutoModel: { from_pretrained(model: string, options: object): Promise<unknown> };
  FeatureExtractionPipeline: new (options: object) => (input: string, options: object) => Promise<{ data: ArrayLike<number> }>;
}
async function loadRuntime(): Promise<Runtime> {
  // Optional peer dependency: keyword mode never imports or installs this runtime.
  const packageName = '@huggingface/transformers';
  return import(packageName);
}

export async function createLocalEmbedder(options: {
  model: string; revision: string; cacheDir?: string; allowDownload: boolean;
}, loader: () => Promise<Runtime> = loadRuntime): Promise<Embedder> {
  if (!/^[a-f0-9]{40}$/u.test(options.revision)) throw new Error('Embedding revision must be an immutable model commit SHA');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(options.model)) throw new Error('Embedding model must be an owner/repository name');
  const { AutoTokenizer, AutoModel, FeatureExtractionPipeline, env } = await loader();
  env.allowRemoteModels = options.allowDownload;
  if (options.cacheDir) env.cacheDir = options.cacheDir;
  const cache = resolve(env.cacheDir);
  const pinnedPath = resolve(cache,options.model,options.revision);
  const cached = ['config.json','tokenizer.json','tokenizer_config.json','onnx/model_quantized.onnx']
    .every(file => existsSync(join(pinnedPath,file)));
  // v4 discovery ignores revision for tokenizer-existence probes. Loading the
  // immutable local directory avoids mutable-main probes when using cached files.
  const source = cached || !options.allowDownload ? pinnedPath : options.model;
  const pretrained = { revision: options.revision,local_files_only: !options.allowDownload,cache_dir: cache,dtype: 'q8',device: 'cpu' };
  const tokenizer = await AutoTokenizer.from_pretrained(source,pretrained);
  const model = await AutoModel.from_pretrained(source,pretrained);
  const extractor = new FeatureExtractionPipeline({ task: 'feature-extraction',model,tokenizer });
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
