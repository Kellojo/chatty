-- Messages written while a reply is still running, sent one at a time by the
-- server once the conversation is idle (see src/lib/server/chat/queue.ts).
-- `parts` holds the message's already uploaded file parts (JSON array); `text`
-- is the raw composer text, including a leading `/skill <name>` command.
-- Rollback: DROP TABLE queued_messages; ALTER TABLE conversations DROP COLUMN queue_paused;
CREATE TABLE queued_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  parts TEXT NOT NULL DEFAULT '[]',
  position INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_queued_messages_conversation ON queued_messages(conversation_id, position);

-- The queue waits for the user: the last reply was stopped or failed, or a
-- queued message could not be sent.
ALTER TABLE conversations ADD COLUMN queue_paused INTEGER NOT NULL DEFAULT 0;
