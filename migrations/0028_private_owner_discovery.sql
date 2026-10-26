-- Indexed empty-owner scheduler discovery; no owner reassignment or data migration.
CREATE INDEX command_jobs_owner_state ON command_jobs(owner,state,created_at,message_id);
CREATE INDEX inbound_sender_ack ON inbound_messages(sender,ack_state);
CREATE INDEX call_sessions_owner_updated ON call_sessions(owner,updated_at);
