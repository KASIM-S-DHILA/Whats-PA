CREATE TABLE inbound_messages (
  message_id TEXT PRIMARY KEY NOT NULL,
  sender TEXT NOT NULL,
  phone_number_id TEXT NOT NULL,
  message_type TEXT NOT NULL,
  message_timestamp TEXT,
  payload_json TEXT NOT NULL,
  received_at TEXT NOT NULL,
  ack_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (ack_state IN ('pending', 'sending', 'sent', 'failed', 'uncertain')),
  ack_message_id TEXT,
  ack_http_status INTEGER,
  ack_updated_at TEXT
);
