ALTER TABLE command_jobs ADD COLUMN prepared_reply_json TEXT;
CREATE TABLE assistant_state (
 owner TEXT PRIMARY KEY NOT NULL,
 candidates_json TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE TABLE assistant_turns (
 message_id TEXT PRIMARY KEY NOT NULL REFERENCES command_jobs(message_id),
 owner TEXT NOT NULL,
 user_text TEXT NOT NULL,
 reply_text TEXT NOT NULL,
 intent TEXT NOT NULL,
 route_probability REAL NOT NULL,
 routing_ms INTEGER NOT NULL,
 total_ms INTEGER NOT NULL,
 tool_name TEXT,
 created_at TEXT NOT NULL
);
CREATE INDEX assistant_turns_owner ON assistant_turns(owner,created_at);
