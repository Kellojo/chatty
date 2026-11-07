-- 0032_conversation_settled.sql
-- Settled conversations are hidden from the default sidebar list but stay
-- fully accessible. settled_reason is 'manual' or 'auto'.
-- Rollback: DROP INDEX idx_conversations_user_settled; ALTER TABLE conversations DROP COLUMN settled_reason; ALTER TABLE conversations DROP COLUMN settled_at;
ALTER TABLE conversations ADD COLUMN settled_at INTEGER;
ALTER TABLE conversations ADD COLUMN settled_reason TEXT;
CREATE INDEX idx_conversations_user_settled ON conversations(user_id, settled_at DESC) WHERE deleted_at IS NULL;
