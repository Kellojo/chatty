-- Subagents (`run_subagent`): hidden `agent-run` conversations a chat (or an
-- agent run) started to work on a task in their own context. `subagent_of` is
-- the conversation that started it: the subagent shares its workspace, and is
-- purged with it.
-- Rollback: DROP INDEX idx_conversations_subagent_of; ALTER TABLE conversations DROP COLUMN subagent_of;
ALTER TABLE conversations ADD COLUMN subagent_of TEXT REFERENCES conversations(id) ON DELETE CASCADE;
CREATE INDEX idx_conversations_subagent_of ON conversations(subagent_of)
  WHERE subagent_of IS NOT NULL;
