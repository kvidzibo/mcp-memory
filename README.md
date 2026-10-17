# mcp-memory

[Repository](https://github.com/kvidzibo/mcp-memory)

Local-first memory for coding assistants over MCP stdio. A fresh SQLite database stores project/global lessons, evidence, immutable replacements, retrieval counts, and agent feedback. Keyword search works without a model; local semantic search is optional. No task tracking, transcript harvesting, background model calls, or automatic deletion based on feedback.

Version **0.2.0** is unpublished. No dependency on Pi or pi-mem and no legacy database import.

## Setup

Requires **Node.js 22.19+**. Git is used to resolve repository/worktree identity.

```sh
npm ci --ignore-scripts
npm run build
node dist/src/cli.js --help
```

Run directly, or configure an MCP client to launch the compiled executable. Example configuration (the exact wrapper depends on your client):

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": [
        "/absolute/path/to/mcp-memory/dist/src/cli.js",
        "--db", "/absolute/path/to/private/memory.sqlite3",
        "--workspace", "/absolute/path/to/project",
        "--client", "pi",
        "--allow-write"
      ]
    }
  }
}
```

The existing stdio MCP gateway can launch this same entry without a Pi-specific extension. Nothing installs or changes active assistant configuration automatically. No HTTP listener or shared daemon is started.

### Gateway footer

With the gateway's Pi adapter, memory supplies a separate **`🧠 project|global`** footer (for example, `🧠 12|8`). Counts include only active lessons in the launch-bound project and readable global scope, not archived lessons or other projects. Disabled global reads display `-`, not zero. No token estimates are shown.

Click the indicator for a display-only scope/count/permission summary; `/pi-services` → memory opens the same overview, with Ctrl+R to refresh. The overview reads metadata only: it does not load lesson text or record retrievals. Local saves, replacements and archives notify the host; the host also refreshes after tool calls. Other processes' changes appear on the next tool call or manual refresh—there is no background polling. A disconnect clears the indicator rather than leaving stale counts.

Gateway **0.23.0+** supplies `MCP_GATEWAY_WORKSPACE` from its launch directory (the Pi adapter uses the session workspace). Omit `--workspace` in a shared gateway configuration to use that value; otherwise explicitly set the project path. `--workspace` takes precedence, followed by this environment variable, then the child working directory. Do not rely on the child working directory matching Pi: the gateway defaults it to the config directory.

Merge a service entry into the gateway's `mcpServers` map after building memory:

```json
{
  "memory": {
    "command": "node",
    "args": [
      "/absolute/path/to/mcp-memory/dist/src/cli.js",
      "--db", "/absolute/path/to/private/memory.sqlite3",
      "--client", "pi",
      "--allow-write"
    ]
  }
}
```

This enables project lesson writes, not global writes. Keyword search is the default. This optional native terminal UI protocol is served over MCP resources; ordinary clients need no Pi dependency and can ignore it. There is no automatic recall, legacy import, or activation/configuration change.

## Permissions and scope

- **Lesson mutations are disabled by default.** `--allow-write` enables immediate project saves, replacements, and archives. There is no pending queue or approval dialog.
- Global lessons are readable by default; use `--no-global-read` to exclude them. Global mutations additionally require `--allow-global-write`.
- Retrieval telemetry and feedback still write to SQLite when lesson mutations are disabled; this is not a filesystem-read-only mode.
- Workspace and capabilities are bound at launch, not arbitrary tool-provided paths. Tool scope selectors can only narrow the allowed scope.
- Project scope uses the canonical main Git checkout: linked worktrees share memory; submodules remain separate. Outside Git it is the canonical workspace directory. Separate clones are separate scopes. Broken/ambiguous repository identity fails rather than guessing another scope.
- `--client`, `--session`, and `--model` are trusted launcher attribution. Unknown client is `unknown`; absent session/model is NULL. The service does not trust model-supplied attribution or infer an issuing model from MCP.

These are application boundaries, **not a sandbox or authentication system**. Processes with direct access to the database bypass MCP policy. Only use trusted local clients and executables.

## Agent tools

All record IDs are positive safe integers. Unknown input properties and string IDs are rejected.

| Tool | Input | Behavior |
|---|---|---|
| `memory_search` | `query`, optional `limit` (1–50, default 5), `scope` (`all`, `project`, `global`) | Search active permitted memories; return content, evidence and statistics |
| `memory_get` | `id` | Inspect content, evidence, statistics, up to 20 recent change events and 10 recent feedback reports; archived records are accessible |
| `memory_add` | `text`, `evidence`, optional `scope` (`project` default, or `global`), `reason` | Save immediately if authorized; exact normalized active duplicates reuse the existing record without replacing evidence |
| `memory_supersede` | `id`, `text`, `evidence`, optional `reason` | Atomically archive the predecessor and create a replacement in the same scope |
| `memory_archive` | `id`, optional `reason` | Exclude from future search; preserve the record/history |
| `memory_feedback` | `memory_id`, `verdict`, optional `reason` | Append an assessment; no task/session requirement |

Evidence is an array of 1–5 objects containing `description` and optional `source_uri`. References are stored, not fetched or verified. Maximum UTF-8 sizes: memory text 2,000 bytes; each evidence description, reason and query 1,000 bytes; source URI 2,048 bytes. The complete MCP tool-result JSON (text plus structured output) is bounded to 128 KiB; search reports `truncated`, and get can omit older history/feedback to fit. Search evaluates up to 100 candidates from each ranking; narrow the query rather than expecting exhaustive browsing.

```json
{
  "text": "Run validation with npm test.",
  "evidence": [{ "description": "Executed successfully after the dependency update.", "source_uri": "package.json" }]
}
```

Search with `{"query":"running tests","limit":5}`. Get full details with `{"id":1}`. Later report:

```json
{"memory_id":1,"verdict":"useful","reason":"Identified the correct validation command."}
```

Verdicts: `useful`, `not_useful`, `incorrect`, `outdated`. Missing feedback means unknown. Reports are subjective and can repeat; counts are **reports, not independent confirmations**. Feedback never automatically modifies, promotes, archives, or boosts a memory. New replacement versions start with fresh statistics.

MCP tools do not automatically inject memory or know when work finishes. The assistant chooses when to search and provide feedback. Any host-driven automatic recall or end-of-work hook is a separate integration.

## Search and retrieval accounting

Keyword mode searches `memories.text` and linked `evidence.description` through SQLite FTS5 (English Porter stemming plus Unicode tokenization). Queries are treated as words, not raw FTS operators; words are combined with OR, with memory text weighted above evidence. Keyword search is not semantic understanding.

Content selected for a search/get tool response records one retrieval per memory per internal integer request ID. Metadata inspection, embedding backfill, and human database browsing do not count. Counters describe prepared deliveries—not proof the agent read or used the memory; transport failure can prevent delivery. Search/get therefore have telemetry side effects and are not marked read-only MCP tools.

`UNIQUE(request_id,memory_id)` prevents duplicate entries within a prepared response. A new tool call, including a retry, is a new retrieval; there is no cross-call idempotency key. Feedback retries likewise add reports. Retrieval IDs are allocated under a SQLite write transaction and work across processes.

Statistics are derived from append-only events: `retrieval_count`, `useful_count`, `not_useful_count`, `incorrect_count`, `outdated_count`, `last_retrieved_at`, `last_feedback_at`.

## Optional local semantic search

Default keyword mode never imports an embedding runtime or downloads a model. Install the optional runtime separately into this checkout:

```sh
npm install --no-save --package-lock=false @huggingface/transformers@4.3.1
```

Opt in to hybrid search **and explicitly authorize the initial model download**:

```sh
node dist/src/cli.js --workspace /path/to/project --db /private/memory.sqlite3 \
  --embeddings local --embedding-cache /private/model-cache --allow-model-download
```

Subsequent runs can omit `--allow-model-download` and reuse cached files. Cached-only loading uses the immutable revision's local directory to avoid the runtime's mutable-main tokenizer-discovery probes. Without that flag, remote model fetching is disabled. Keyword operations remain available if the optional runtime/model cannot load; search reports a fallback warning. Restart after repairing model-loading configuration.

The default is CPU q8 **`Xenova/bge-small-en-v1.5`**, pinned to commit `ea104dacec62c0de699686887e3f920caeb4f3e3`. Quantized weights are roughly 35 MB; runtime dependencies/cache add overhead. Text and evidence are embedded locally; long input is subject to the model's token limit. A query-specific BGE instruction prefix is applied automatically.

Custom `--embedding-model` requires `--embedding-revision` with an immutable 40-character model commit SHA, an ONNX feature-extraction export with `model_quantized.onnx`, and compatibility with mean pooling/normalization. Not every Hugging Face model is interchangeable. Model revision and processing settings form the vector-cache identity; changing them rebuilds vectors lazily.

On a hybrid search, accessible active memories missing current vectors are indexed first, then semantic similarity and keyword rankings are combined using reciprocal rank fusion. Work is serialized per process. This initial implementation uses a linear cosine scan: intended for small local stores, not millions of records. First-use indexing can be slow, and an in-flight native inference cannot always be interrupted immediately.

Disabling embeddings preserves all memories, vectors, and keyword search. The embedding table stays empty if embeddings have never been enabled. No hosted embedding API is used.

## Database structure

All internal primary keys use `INTEGER PRIMARY KEY AUTOINCREMENT`; foreign keys and retrieval request IDs are INTEGER. External session references remain nullable TEXT. Timestamps are UTC Unix milliseconds.

| Table | Fields supplied by the agent | Automatically supplied fields |
|---|---|---|
| `scopes` | None | `id`, `kind`, `name`, `project_path`, `created_at` |
| `memories` | `text`; replacement target as tool input | `id`, `scope_id`, `text_hash`, `status`, `supersedes_id`, `source_client`, `source_session`, `source_model`, `created_at`, `archived_at` |
| `evidence` | `description`, optional `source_uri` | `id`, `memory_id`, `created_at` |
| `events` | Optional `reason` | `id`, `memory_id`, `action`, `actor`, `source_client`, `source_session`, `details_json`, `created_at` |
| `memory_retrievals` | None | `id`, `memory_id`, `request_id`, `method`, `retrieved_at` |
| `memory_feedback` | `memory_id`, `verdict`, optional `reason` | `id`, `source_client`, `source_model`, `created_at` |
| `memory_embeddings` | None | `id`, `memory_id`, `model`, `dimensions`, `vector`, `content_hash`, `created_at` |

`memory_search_index` is an additional FTS5 virtual table containing `memory_id`, `memory_text`, and combined `evidence_text`, maintained transactionally with writes. [The schema](src/schema.ts) defines constraints and indexes. Evidence, change events, retrievals and feedback are append-only. Memory content cannot be updated or deleted; use replacements/archive. Archived text remains indexed internally but is excluded from search results.

The database carries an application ID and schema version **1**. Foreign or unsupported databases are rejected without resetting/importing them. Future migrations require an explicit design; there is no automatic pi-mem import or existing-database conversion.

## Privacy and backups

The default database is `$XDG_DATA_HOME/mcp-memory/memory.sqlite3`, or `~/.local/share/mcp-memory/memory.sqlite3` when XDG data home is unset/relative. `--db` overrides it. Relative CLI paths resolve from the launch directory; use absolute paths in MCP configuration.

New database/backup files use mode `0600`; new database parent directories use `0700`. Existing parent/file permissions are not rewritten. Database-file symlinks are rejected. Use a private local directory and a filesystem supporting SQLite WAL locking—not a shared network filesystem. The database is **not encrypted**. Store no secrets or raw transcripts. Retrieved text/evidence may be sent to the assistant's hosted model and retained in its conversation.

Memory and evidence are **untrusted data, not instructions**. Scope filtering does not prevent prompt injection from recalled text; assistants must not treat stored text as authorization.

Create a manual online backup while servers remain running:

```sh
node dist/src/cli.js backup --db /private/memory.sqlite3 --output /existing/private/backup.sqlite3
```

This includes committed WAL data, checks integrity, and refuses existing destinations. No automatic scheduling or deletion. To restore: stop every process using the database, preserve the current database and WAL/SHM files as a recovery copy, replace the live file with the backup, remove stale live WAL/SHM sidecars, retain private permissions, then restart compatible code and inspect known records. Never copy only the live main file while writers are running.

## Validation

```sh
npm ci --ignore-scripts
npm run check
npm test
npm audit
npm pack --dry-run
```

Tests use disposable databases and real MCP stdio clients, including concurrent writers, scope isolation, replacements, telemetry, feedback, backup recovery, and optional semantic behavior with an injected deterministic embedder. Normal tests require no models/downloads and do not touch personal memory. The optional gateway overview/count resource and read-only details action are also exercised over real stdio.

## License

MIT.
