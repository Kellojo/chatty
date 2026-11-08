-- 0043_coding_thread_index.sql
-- Coding tasks are matched to their T3 threads by thread id. Not UNIQUE: the
-- same thread may be followed by several users' conversations.
CREATE INDEX IF NOT EXISTS idx_coding_conversations_thread ON coding_conversations(thread_id);
