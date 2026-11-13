-- Refresh-token reuse detection for the MCP gateway's OAuth server (RFC 9700 §4.14.2).
-- A rotated refresh token is kept, marked with used_at, until it expires. Presenting it
-- again means it leaked: every token of that key and client is revoked.
--
-- Rollback: ALTER TABLE oauth_tokens DROP COLUMN used_at;
ALTER TABLE oauth_tokens ADD COLUMN used_at INTEGER;
