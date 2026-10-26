-- Call history for the memory lane. Raw rows live seven days and are deleted by the retention sweep.
-- user_turn rows hold finalized caller words only. tool_outcome rows are copied from the backend job records, never from assistant claims.
CREATE TABLE call_history_turns (
 owner TEXT NOT NULL,
 call_id TEXT NOT NULL,
 turn_key TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('user_turn','tool_outcome')),
 revision INTEGER NOT NULL CHECK(revision>=1),
 text TEXT,
 tool_name TEXT,
 outcome TEXT,
 confirmed INTEGER CHECK(confirmed IN (0,1)),
 occurred_at TEXT NOT NULL,
 recorded_at TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 PRIMARY KEY(owner,call_id,turn_key),
 CHECK((kind='user_turn' AND text IS NOT NULL AND tool_name IS NULL) OR (kind='tool_outcome' AND text IS NULL AND tool_name IS NOT NULL AND outcome IS NOT NULL))
);
CREATE INDEX call_history_turns_expiry ON call_history_turns(owner,expires_at);
CREATE INDEX call_history_turns_recent ON call_history_turns(owner,occurred_at);
