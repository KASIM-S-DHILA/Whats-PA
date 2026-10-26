ALTER TABLE assistant_state ADD COLUMN context_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE command_jobs ADD COLUMN timings_json TEXT;
CREATE TABLE chat_proposals (
 proposal_id TEXT PRIMARY KEY NOT NULL,
 owner TEXT NOT NULL,
 dataset TEXT NOT NULL,
 origin_message_id TEXT NOT NULL REFERENCES command_jobs(message_id),
 source_reply_id TEXT,
 action TEXT NOT NULL CHECK(action IN ('send','note')),
 payload_json TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','pending','editing','executing','done','cancelled','superseded','failed','uncertain')),
 executing_message_id TEXT,
 expires_at INTEGER NOT NULL,
 created_at TEXT NOT NULL
);
CREATE INDEX chat_proposals_owner ON chat_proposals(owner,state,expires_at);
