CREATE TABLE reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  text TEXT NOT NULL,
  next_due_at INTEGER NOT NULL,
  repeat TEXT NOT NULL DEFAULT 'none' CHECK(repeat IN ('none','daily','weekly')),
  snooze_until INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','failed','uncertain','cancelled')),
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_sent_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX reminders_due ON reminders(owner,state,next_due_at);
