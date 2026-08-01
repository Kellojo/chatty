-- Auto-compaction summaries: one row per compaction run; the latest row per
-- conversation marks messages (by rowid) folded into summary_text.
-- Rollback: DROP TABLE conversation_summaries;
CREATE TABLE conversation_summaries (
	id TEXT PRIMARY KEY,
	conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
	through_message_id TEXT NOT NULL,
	through_rowid INTEGER NOT NULL,
	summary_text TEXT NOT NULL,
	token_estimate INTEGER NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX idx_conv_summaries_conv ON conversation_summaries(conversation_id, created_at);
