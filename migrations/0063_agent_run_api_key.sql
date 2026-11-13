-- The API key that started an agent run over HTTP (trigger 'http'), so a key's
-- usage statistics count its runs and the model requests those runs made.
-- Null for runs started any other way, and for HTTP runs from before this column.
-- No foreign key: like proxy_requests.api_key_id, the history outlives a deleted key.
--
-- Rollback: DROP INDEX idx_agent_runs_api_key_id; ALTER TABLE agent_runs DROP COLUMN api_key_id;
ALTER TABLE agent_runs ADD COLUMN api_key_id TEXT;

CREATE INDEX idx_agent_runs_api_key_id ON agent_runs(api_key_id);
