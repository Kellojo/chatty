-- 0037_coding_run_and_diff.sql
-- When the task's current agent run started (NULL when nothing runs), and the
-- thread's change size (+/- lines) as T3 Code reports it; NULL = not loaded yet.
-- Rollback: ALTER TABLE coding_conversations DROP COLUMN run_started_at; ALTER TABLE coding_conversations DROP COLUMN diff_insertions; ALTER TABLE coding_conversations DROP COLUMN diff_deletions;
ALTER TABLE coding_conversations ADD COLUMN run_started_at INTEGER;
ALTER TABLE coding_conversations ADD COLUMN diff_insertions INTEGER;
ALTER TABLE coding_conversations ADD COLUMN diff_deletions INTEGER;
