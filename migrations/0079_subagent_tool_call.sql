-- The model's tool call (`run_subagent`) a subagent's conversation answers, so
-- the parent chat's row can find (and link to) the subagent while it works.
-- Rollback: DROP INDEX idx_conversations_subagent_call; ALTER TABLE conversations DROP COLUMN subagent_tool_call_id;
ALTER TABLE conversations ADD COLUMN subagent_tool_call_id TEXT;
CREATE INDEX idx_conversations_subagent_call ON conversations(subagent_of, subagent_tool_call_id)
  WHERE subagent_tool_call_id IS NOT NULL;
