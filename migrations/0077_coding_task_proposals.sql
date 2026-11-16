-- Coding tasks started from a chat's `propose_coding_task` card remember the
-- chat and tool call they came from: the card shows the task's status, the
-- chat's model reads it, and the chat gets a notice when the task first
-- finishes (`proposal_reported_at`). One task per proposal (the unique index).
-- Rollback: DROP INDEX idx_coding_conversations_proposal; ALTER TABLE coding_conversations DROP COLUMN proposal_reported_at; ALTER TABLE coding_conversations DROP COLUMN proposed_tool_call_id; ALTER TABLE coding_conversations DROP COLUMN proposed_in;
ALTER TABLE coding_conversations ADD COLUMN proposed_in TEXT REFERENCES conversations(id) ON DELETE SET NULL;
ALTER TABLE coding_conversations ADD COLUMN proposed_tool_call_id TEXT;
ALTER TABLE coding_conversations ADD COLUMN proposal_reported_at INTEGER;
CREATE UNIQUE INDEX idx_coding_conversations_proposal
  ON coding_conversations(proposed_in, proposed_tool_call_id)
  WHERE proposed_in IS NOT NULL;
