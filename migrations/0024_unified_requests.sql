-- 0024_unified_requests.sql
-- Extend proxy_requests into a unified request log covering proxy traffic,
-- chat conversations, and agent runs. One row per model inference step.

ALTER TABLE proxy_requests ADD COLUMN source TEXT NOT NULL DEFAULT 'proxy';
ALTER TABLE proxy_requests ADD COLUMN conversation_id TEXT;
ALTER TABLE proxy_requests ADD COLUMN run_id TEXT;
ALTER TABLE proxy_requests ADD COLUMN message_id TEXT;
ALTER TABLE proxy_requests ADD COLUMN step_index INTEGER NOT NULL DEFAULT 0;
ALTER TABLE proxy_requests ADD COLUMN purpose TEXT NOT NULL DEFAULT 'completion';

CREATE INDEX idx_proxy_requests_source ON proxy_requests (source);
CREATE INDEX idx_proxy_requests_conversation_id ON proxy_requests (conversation_id);
CREATE INDEX idx_proxy_requests_run_id ON proxy_requests (run_id);
