-- 0035_coding_settled_sync.sql
-- Last settled state Chatty and the task's T3 Code thread agreed on (0/1;
-- NULL = never compared). Lets the two-way sync tell which side changed.
-- Rollback: ALTER TABLE coding_conversations DROP COLUMN remote_settled;
ALTER TABLE coding_conversations ADD COLUMN remote_settled INTEGER;
