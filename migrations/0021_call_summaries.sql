CREATE TABLE call_summary_jobs (
 call_id TEXT PRIMARY KEY NOT NULL REFERENCES call_sessions(call_id),
 owner TEXT NOT NULL,
 input_hash TEXT NOT NULL,
 caller_json TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','leased','kept','skipped','failed')),
 attempts INTEGER NOT NULL DEFAULT 0,
 lease_token TEXT,
 lease_until INTEGER NOT NULL DEFAULT 0,
 next_attempt_at INTEGER NOT NULL DEFAULT 0,
 error_code TEXT,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 source_expires_at INTEGER NOT NULL
);
CREATE INDEX call_summary_jobs_ready ON call_summary_jobs(owner,state,next_attempt_at,lease_until);
CREATE TABLE call_summaries (
 call_id TEXT PRIMARY KEY NOT NULL REFERENCES call_summary_jobs(call_id),
 owner TEXT NOT NULL,
 input_hash TEXT NOT NULL,
 summary TEXT NOT NULL,
 topics_json TEXT NOT NULL,
 outcomes_json TEXT NOT NULL,
 file_id TEXT UNIQUE NOT NULL,
 bucket TEXT NOT NULL,
 object_key TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL
);
CREATE INDEX call_summaries_expiry ON call_summaries(expires_at);
CREATE TABLE call_summary_budget (
 day TEXT PRIMARY KEY NOT NULL,
 reserved_requests INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE call_summary_objects (
 object_key TEXT PRIMARY KEY NOT NULL,
 owner TEXT NOT NULL,
 bucket TEXT NOT NULL,
 expires_at INTEGER NOT NULL
);
CREATE INDEX call_summary_objects_expiry ON call_summary_objects(expires_at);
