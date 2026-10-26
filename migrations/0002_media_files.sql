ALTER TABLE inbound_messages ADD COLUMN media_expected INTEGER NOT NULL DEFAULT 0;

CREATE TABLE media_files (
  message_id TEXT PRIMARY KEY NOT NULL REFERENCES inbound_messages(message_id),
  sender TEXT NOT NULL,
  media_id TEXT NOT NULL,
  message_type TEXT NOT NULL,
  is_voice_note INTEGER NOT NULL DEFAULT 0,
  filename TEXT,
  mime_type TEXT,
  byte_size INTEGER,
  sha256 TEXT,
  storage_provider TEXT NOT NULL DEFAULT 'supabase',
  bucket TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processing','ready','rejected','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX media_jobs_due ON media_files(state, next_attempt_at, lease_until);
