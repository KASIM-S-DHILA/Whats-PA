-- Additive indexes for scheduler recovery/discovery.
-- Production BEFORE plans were captured without these indexes.
-- AFTER plans are full-schema local only; production plans with these indexes are unverified.
CREATE INDEX call_sessions_active_updated ON call_sessions(updated_at) WHERE state!='terminated';
CREATE INDEX call_tool_jobs_recovery ON call_tool_jobs(state,updated_at);
CREATE INDEX catalog_pending_due ON file_catalog(owner,dataset,next_attempt_at,created_at) WHERE index_state='pending';
CREATE INDEX catalog_processing_due ON file_catalog(owner,dataset,lease_until,created_at) WHERE index_state='processing';
