CREATE TABLE file_catalog (
 file_id TEXT PRIMARY KEY NOT NULL,
 owner TEXT NOT NULL,
 dataset TEXT NOT NULL DEFAULT 'live',
 message_id TEXT NOT NULL UNIQUE,
 kind TEXT NOT NULL,
 voice_note INTEGER NOT NULL DEFAULT 0,
 filename TEXT NOT NULL,
 mime_type TEXT NOT NULL,
 byte_size INTEGER NOT NULL,
 sha256 TEXT,
 bucket TEXT,
 object_key TEXT,
 source_epoch INTEGER NOT NULL,
 extracted_text TEXT NOT NULL DEFAULT '',
 extraction_status TEXT NOT NULL DEFAULT 'pending',
 extraction_method TEXT,
 index_state TEXT NOT NULL DEFAULT 'pending' CHECK(index_state IN ('pending','processing','ready','failed')),
 index_cursor INTEGER NOT NULL DEFAULT 0,
 vector_count INTEGER NOT NULL DEFAULT 0,
 index_attempts INTEGER NOT NULL DEFAULT 0,
 lease_until INTEGER NOT NULL DEFAULT 0,
 lease_token TEXT,
 next_attempt_at INTEGER NOT NULL DEFAULT 0,
 reason TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX catalog_owner_date ON file_catalog(owner,dataset,source_epoch);
CREATE INDEX catalog_index_jobs ON file_catalog(index_state,next_attempt_at,lease_until);
CREATE TABLE file_chunks (
 file_id TEXT NOT NULL REFERENCES file_catalog(file_id),
 position INTEGER NOT NULL,
 content TEXT NOT NULL,
 PRIMARY KEY(file_id,position)
);
CREATE TABLE command_jobs (
 message_id TEXT PRIMARY KEY NOT NULL REFERENCES inbound_messages(message_id),
 owner TEXT NOT NULL,
 kind TEXT NOT NULL,
 arguments_json TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending',
 lease_until INTEGER NOT NULL DEFAULT 0,
 lease_token TEXT,
 created_at TEXT NOT NULL
);
CREATE INDEX command_jobs_pending ON command_jobs(state,lease_until);
