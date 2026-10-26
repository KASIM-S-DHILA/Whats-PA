-- Isolated foundation only, no chat/call integration or background retention jobs yet.
CREATE TABLE memory_policy (
 owner TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 1,
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
 automatic INTEGER NOT NULL DEFAULT 0 CHECK(automatic IN (0,1))
);
CREATE TABLE memory_sources (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, source_id TEXT NOT NULL,
 revision INTEGER NOT NULL, source_time TEXT NOT NULL, received_at TEXT NOT NULL,
 expires_at TEXT NOT NULL, text TEXT NOT NULL, explicit INTEGER NOT NULL,
 eligible INTEGER NOT NULL, policy_version INTEGER NOT NULL, UNIQUE(owner,source_id,revision)
);
CREATE TABLE memory_records (
 owner TEXT NOT NULL, record_id TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL,
 scope TEXT NOT NULL, version INTEGER NOT NULL, fields_json TEXT,
 source_id TEXT, source_revision INTEGER, source_time TEXT,
 evidence_quote TEXT, forgotten INTEGER NOT NULL DEFAULT 0 CHECK(forgotten IN (0,1)),
 source_stale INTEGER NOT NULL DEFAULT 0 CHECK(source_stale IN (0,1)),
 forgotten_at TEXT, forgotten_seq INTEGER, updated_at TEXT NOT NULL,
 PRIMARY KEY(owner,record_id), UNIQUE(owner,kind,key,scope)
);
CREATE TABLE memory_operations (
 owner TEXT NOT NULL, operation_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
 nonce TEXT NOT NULL, receipt_json TEXT, created_at TEXT NOT NULL,
 PRIMARY KEY(owner,operation_id)
);
-- A failed assertion is a real SQLite constraint error, so D1 rolls back the whole batch.
-- Zero affected rows on an ordinary UPDATE would not provide this property.
CREATE TABLE memory_guards (nonce TEXT NOT NULL, valid INTEGER NOT NULL CHECK(valid=1));
CREATE INDEX memory_records_scope ON memory_records(owner,scope,forgotten);
CREATE INDEX memory_sources_latest ON memory_sources(owner,source_id,revision);
