-- Isolated proposal staging only. Not applied to remote or live databases.
CREATE TABLE memory_proposals (
 owner TEXT NOT NULL, proposal_id TEXT NOT NULL,
 source_id TEXT NOT NULL, source_revision INTEGER NOT NULL, source_seq INTEGER NOT NULL,
 source_hash TEXT NOT NULL, policy_version INTEGER NOT NULL,
 context_json TEXT NOT NULL, patches_json TEXT NOT NULL, fingerprint TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','accepted','rejected','promoted')),
 version INTEGER NOT NULL CHECK(version>=1), review_json TEXT, review_fingerprint TEXT,
 receipt_json TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
 PRIMARY KEY(owner,proposal_id),
 CHECK(state<>'promoted' OR receipt_json IS NOT NULL)
);
CREATE INDEX memory_proposals_expiry ON memory_proposals(owner,expires_at);
