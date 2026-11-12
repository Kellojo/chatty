-- 0058_conversation_snooze.sql
-- Snoozing hides a conversation from the active list until `snoozed_until`
-- (epoch ms); `snoozed_at` is when it was snoozed. When the snooze ends (on
-- time, or early: the user wakes it or it needs them) both are cleared and
-- `woke_at` records when it came back, so it sorts as fresh activity.
-- `coding_conversations.remote_snoozed_until` is the snooze last agreed with
-- the T3 Code thread (ms, 0 = not snoozed), NULL if never compared.
-- Rollback: ALTER TABLE conversations DROP COLUMN snoozed_at; ALTER TABLE conversations DROP COLUMN snoozed_until; ALTER TABLE conversations DROP COLUMN woke_at; ALTER TABLE coding_conversations DROP COLUMN remote_snoozed_until; DROP INDEX idx_conversations_snoozed_until;
ALTER TABLE conversations ADD COLUMN snoozed_at INTEGER;
ALTER TABLE conversations ADD COLUMN snoozed_until INTEGER;
ALTER TABLE conversations ADD COLUMN woke_at INTEGER;
ALTER TABLE coding_conversations ADD COLUMN remote_snoozed_until INTEGER;

CREATE INDEX idx_conversations_snoozed_until ON conversations(snoozed_until)
  WHERE snoozed_until IS NOT NULL;
