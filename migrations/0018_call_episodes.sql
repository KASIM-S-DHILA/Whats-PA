-- Ninety day call episodes and the bounded jobs that write them. Raw call history stays seven days and is never extended by a failed job.
-- One job per call. The lease token and input digest let a stale or erased input be refused at publication.
CREATE TABLE call_episode_jobs (
 owner TEXT NOT NULL,
 call_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','leased','done','skipped','failed')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
 input_digest TEXT NOT NULL,
 lease_token TEXT,
 lease_until TEXT,
 error_code TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(owner,call_id)
);
CREATE INDEX call_episode_jobs_ready ON call_episode_jobs(owner,state,updated_at);
CREATE TABLE call_episodes (
 owner TEXT NOT NULL,
 call_id TEXT NOT NULL,
 input_digest TEXT NOT NULL,
 summary TEXT NOT NULL,
 topics_json TEXT NOT NULL,
 outcomes_json TEXT NOT NULL,
 turn_count INTEGER NOT NULL CHECK(turn_count>=1),
 started_at TEXT NOT NULL,
 ended_at TEXT NOT NULL,
 created_at TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 PRIMARY KEY(owner,call_id)
);
CREATE INDEX call_episodes_expiry ON call_episodes(owner,expires_at);
CREATE INDEX call_episodes_recent ON call_episodes(owner,ended_at);
