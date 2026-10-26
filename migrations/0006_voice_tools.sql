ALTER TABLE call_sessions ADD COLUMN tool_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE call_sessions ADD COLUMN candidates_json TEXT NOT NULL DEFAULT '[]';
CREATE TABLE call_tool_jobs (
 operation_id TEXT PRIMARY KEY NOT NULL,
 call_id TEXT NOT NULL REFERENCES call_sessions(call_id),
 revision INTEGER NOT NULL,
 name TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 arguments_json TEXT NOT NULL,
 state TEXT NOT NULL,
 result_json TEXT,
 prepared_json TEXT,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE INDEX call_tool_jobs_call ON call_tool_jobs(call_id,revision);
CREATE TABLE call_artifacts (
 call_id TEXT NOT NULL REFERENCES call_sessions(call_id),
 kind TEXT NOT NULL CHECK(kind IN ('recording','transcript')),
 message_id TEXT UNIQUE NOT NULL REFERENCES inbound_messages(message_id),
 media_id TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(call_id,kind)
);
