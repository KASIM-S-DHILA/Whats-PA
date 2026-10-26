-- Shadow routing log for the chat memory lane. Local and test databases only until rollout is authorized, and NOT applied to remote or live D1.
-- Stores routing metadata only: no user text, no values, no quotes. Rows expire after seven days.
CREATE TABLE memory_shadow_log (
 owner TEXT NOT NULL,
 shadow_id TEXT NOT NULL,
 message_hash TEXT NOT NULL,
 mode TEXT NOT NULL CHECK(mode IN ('lifecycle','read_only')),
 action TEXT NOT NULL CHECK(action IN ('none','read','prepare_write','propose_write','forget','cancel','error')),
 key TEXT,
 scope TEXT,
 review_decision TEXT,
 review_reason TEXT,
 steps INTEGER NOT NULL CHECK(steps BETWEEN 0 AND 2),
 elapsed_ms INTEGER NOT NULL CHECK(elapsed_ms>=0),
 error_code TEXT,
 created_at TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 PRIMARY KEY(owner,shadow_id)
);
CREATE INDEX memory_shadow_log_expiry ON memory_shadow_log(owner,expires_at);
