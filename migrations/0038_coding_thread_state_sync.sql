-- 0038_coding_thread_state_sync.sql
-- Extends the two-way sync between a coding task and its T3 Code thread (see
-- 0035) to the title and pinned state, and remembers the thread's last seen
-- `lastVisitedAt` (epoch ms, 0 = never visited) for the read state.
-- NULL = never compared.
-- Rollback: ALTER TABLE coding_conversations DROP COLUMN remote_title; ALTER TABLE coding_conversations DROP COLUMN remote_pinned; ALTER TABLE coding_conversations DROP COLUMN remote_visited_at;
ALTER TABLE coding_conversations ADD COLUMN remote_title TEXT;
ALTER TABLE coding_conversations ADD COLUMN remote_pinned INTEGER;
ALTER TABLE coding_conversations ADD COLUMN remote_visited_at INTEGER;
