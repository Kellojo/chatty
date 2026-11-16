-- How a subagent ended, recorded by its runner: 'completed' | 'failed' | 'stopped'
-- (NULL while it runs, or when the server stopped mid-run). The transcript page
-- and the parent's row read it instead of guessing from the last message.
-- Rollback: ALTER TABLE conversations DROP COLUMN subagent_status; ALTER TABLE conversations DROP COLUMN subagent_error; ALTER TABLE conversations DROP COLUMN subagent_ended_at;
ALTER TABLE conversations ADD COLUMN subagent_status TEXT;
ALTER TABLE conversations ADD COLUMN subagent_error TEXT;
ALTER TABLE conversations ADD COLUMN subagent_ended_at INTEGER;
