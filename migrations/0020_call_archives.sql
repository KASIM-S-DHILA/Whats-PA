CREATE TABLE call_archives (
 call_id TEXT NOT NULL REFERENCES call_sessions(call_id),
 kind TEXT NOT NULL CHECK(kind IN ('recording','transcript')),
 sha256 TEXT NOT NULL,
 byte_size INTEGER NOT NULL,
 bucket TEXT NOT NULL,
 object_key TEXT NOT NULL,
 filename TEXT NOT NULL,
 file_id TEXT UNIQUE NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','uploading','stored','failed','expired')),
 attempts INTEGER NOT NULL DEFAULT 0,
 lease_token TEXT,
 lease_until INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 PRIMARY KEY(call_id,kind)
);
CREATE INDEX call_archives_expiry ON call_archives(expires_at);
