-- 0036_coding_dismissed_threads.sql
-- Threads started directly in T3 Code are imported as coding conversations.
-- Once such a conversation is deleted from Chatty (purged), its thread is
-- remembered here so the next sync doesn't import it again.
-- Rollback: DROP TRIGGER trg_coding_conversations_dismiss; DROP TABLE coding_dismissed_threads;
CREATE TABLE coding_dismissed_threads (
  environment_id TEXT NOT NULL REFERENCES coding_environments(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL,
  dismissed_at INTEGER NOT NULL,
  PRIMARY KEY (environment_id, thread_id)
);

-- Also fires for the cascade from deleting the conversation row.
CREATE TRIGGER trg_coding_conversations_dismiss AFTER DELETE ON coding_conversations
WHEN OLD.thread_id IS NOT NULL AND OLD.environment_id IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO coding_dismissed_threads (environment_id, thread_id, dismissed_at)
  VALUES (OLD.environment_id, OLD.thread_id, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
END;
