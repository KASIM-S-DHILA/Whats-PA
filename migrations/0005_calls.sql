CREATE TABLE call_sessions (
 call_id TEXT PRIMARY KEY NOT NULL,
 owner TEXT NOT NULL,
 state TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE TABLE call_events (
 event_id TEXT PRIMARY KEY NOT NULL,
 call_id TEXT NOT NULL REFERENCES call_sessions(call_id),
 event TEXT NOT NULL,
 payload_json TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending',
 attempts INTEGER NOT NULL DEFAULT 0,
 lease_token TEXT,
 lease_until INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL
);
CREATE INDEX call_events_pending ON call_events(state,lease_until);
