export const APPLICATION_ID = 0x4d43504d;
export const SCHEMA_VERSION = 1;

export const SCHEMA = `
CREATE TABLE scopes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('project','global')),
  name TEXT NOT NULL,
  project_path TEXT,
  created_at INTEGER NOT NULL,
  CHECK((kind='global' AND project_path IS NULL) OR (kind='project' AND project_path IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX scopes_project ON scopes(project_path) WHERE kind='project';
CREATE UNIQUE INDEX scopes_global ON scopes(kind) WHERE kind='global';
CREATE TABLE memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_id INTEGER NOT NULL REFERENCES scopes(id),
  text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 2000),
  text_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','archived')),
  supersedes_id INTEGER UNIQUE REFERENCES memories(id),
  source_client TEXT NOT NULL,
  source_session TEXT,
  source_model TEXT,
  created_at INTEGER NOT NULL,
  archived_at INTEGER,
  CHECK((status='active' AND archived_at IS NULL) OR (status='archived' AND archived_at IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX memories_active_text ON memories(scope_id,text_hash) WHERE status='active';
CREATE INDEX memories_listing ON memories(scope_id,status,created_at,id);
CREATE TABLE evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id INTEGER NOT NULL REFERENCES memories(id),
  description TEXT NOT NULL CHECK(length(description) BETWEEN 1 AND 1000),
  source_uri TEXT CHECK(source_uri IS NULL OR length(source_uri) BETWEEN 1 AND 2048),
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX evidence_memory ON evidence(memory_id);
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id INTEGER NOT NULL REFERENCES memories(id),
  action TEXT NOT NULL CHECK(action IN ('created','superseded','archived')),
  actor TEXT NOT NULL CHECK(actor IN ('user','agent')),
  source_client TEXT NOT NULL,
  source_session TEXT,
  reason TEXT,
  details_json TEXT NOT NULL CHECK(json_valid(details_json)),
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX events_memory ON events(memory_id,id);
CREATE TABLE memory_retrievals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id INTEGER NOT NULL REFERENCES memories(id),
  request_id INTEGER NOT NULL CHECK(request_id>0),
  method TEXT NOT NULL CHECK(method IN ('search','get','recall')),
  retrieved_at INTEGER NOT NULL,
  UNIQUE(request_id,memory_id)
) STRICT;
CREATE INDEX retrievals_memory ON memory_retrievals(memory_id,retrieved_at);
CREATE TABLE memory_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id INTEGER NOT NULL REFERENCES memories(id),
  verdict TEXT NOT NULL CHECK(verdict IN ('useful','not_useful','incorrect','outdated')),
  reason TEXT,
  source_client TEXT NOT NULL,
  source_model TEXT,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX feedback_memory ON memory_feedback(memory_id,created_at);
CREATE TABLE memory_embeddings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id INTEGER NOT NULL REFERENCES memories(id),
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL CHECK(dimensions BETWEEN 1 AND 16384),
  vector BLOB NOT NULL,
  content_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(memory_id,model),
  CHECK(length(vector)=dimensions*4)
) STRICT;
CREATE VIRTUAL TABLE memory_search_index USING fts5(
  memory_id UNINDEXED, memory_text, evidence_text,
  tokenize='porter unicode61 remove_diacritics 2'
);
CREATE TRIGGER memories_immutable BEFORE UPDATE OF
  id,scope_id,text,text_hash,supersedes_id,source_client,source_session,source_model,created_at ON memories
BEGIN SELECT RAISE(ABORT,'Memory content is immutable; supersede it'); END;
CREATE TRIGGER memories_no_delete BEFORE DELETE ON memories
BEGIN SELECT RAISE(ABORT,'Archive memories instead of deleting them'); END;
CREATE TRIGGER memories_replacement_scope BEFORE INSERT ON memories
WHEN NEW.supersedes_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM memories WHERE id=NEW.supersedes_id AND scope_id=NEW.scope_id
)
BEGIN SELECT RAISE(ABORT,'Replacement must retain its scope'); END;
${['evidence', 'events', 'memory_retrievals', 'memory_feedback'].map(table => `
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table}
BEGIN SELECT RAISE(ABORT,'Append-only table'); END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table}
BEGIN SELECT RAISE(ABORT,'Append-only table'); END;
`).join('')}
`;
