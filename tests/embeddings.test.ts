import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalEmbedder, DEFAULT_EMBEDDING_MODEL, DEFAULT_EMBEDDING_REVISION } from '../src/embeddings.js';

test('local embedding loader pins tokenizer/model and disables remote access in cached-only mode', async () => {
  const calls: { model: string; options: object }[] = [];
  const tokenizer = {}, model = {};
  const env = { allowRemoteModels: true,cacheDir: '' };
  const embedder = await createLocalEmbedder({ model: DEFAULT_EMBEDDING_MODEL,revision: DEFAULT_EMBEDDING_REVISION,
    cacheDir: '/tmp/test-model-cache',allowDownload: false },async () => ({
    env,
    AutoTokenizer: { async from_pretrained(name,options) { calls.push({ model: name,options }); return tokenizer; } },
    AutoModel: { async from_pretrained(name,options) { calls.push({ model: name,options }); return model; } },
    FeatureExtractionPipeline: function(options: { tokenizer: unknown; model: unknown }) {
      assert.equal(options.tokenizer,tokenizer); assert.equal(options.model,model);
      return async (input: string) => {
        assert.match(input,/^Represent this sentence for searching relevant passages: running tests$/);
        return { data: [1,0] };
      };
    } as any,
  }));
  assert.equal(env.allowRemoteModels,false);
  assert.equal(env.cacheDir,'/tmp/test-model-cache');
  assert.equal(calls.length,2);
  for (const call of calls) assert.deepEqual(call,{ model: `/tmp/test-model-cache/${DEFAULT_EMBEDDING_MODEL}/${DEFAULT_EMBEDDING_REVISION}`,options: {
    revision: DEFAULT_EMBEDDING_REVISION,local_files_only: true,cache_dir: '/tmp/test-model-cache',dtype: 'q8',device: 'cpu',
  } });
  assert.deepEqual(await embedder.embed('running tests','query'),[1,0]);
  assert.match(embedder.model,new RegExp(DEFAULT_EMBEDDING_REVISION));
});
