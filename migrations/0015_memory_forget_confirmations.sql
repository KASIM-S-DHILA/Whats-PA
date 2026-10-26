-- Pending "forget this?" confirmations for the memory lane. Local and test databases only, and NOT applied to remote or live D1.
-- A row exists only between a reviewed forget request and the user's button tap. The quoted request is cleared when the row is resolved.
CREATE TABLE memory_forget_confirmations (
 owner TEXT NOT NULL,
 confirmation_id TEXT NOT NULL,
 source_id TEXT NOT NULL,
 source_revision INTEGER NOT NULL CHECK(source_revision>=1),
 scope TEXT NOT NULL,
 key TEXT NOT NULL,
 evidence_quote TEXT,
 reply_message_id TEXT,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','confirmed','cancelled','superseded','failed')),
 outcome TEXT,
 created_at TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 resolved_at TEXT,
 PRIMARY KEY(owner,confirmation_id),
 CHECK(state<>'pending' OR evidence_quote IS NOT NULL)
);
CREATE INDEX memory_forget_confirmations_state ON memory_forget_confirmations(owner,state,expires_at);
