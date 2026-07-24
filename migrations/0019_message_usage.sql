-- 0019_message_usage.sql
-- Per-message generation metadata for assistant messages (debug info popover).
-- JSON: { providerId, modelId, inputTokens, outputTokens, totalTokens, latencyMs, costUsd }

ALTER TABLE messages ADD COLUMN usage_json TEXT;
