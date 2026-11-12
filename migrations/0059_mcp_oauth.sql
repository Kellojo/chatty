-- OAuth for remote MCP servers. A server with auth = 'oauth' is reached with each
-- user's own access token, obtained by signing in through the authorization
-- server the MCP server advertises (RFC 9728 protected resource metadata).
--
-- On mcp_servers (shared by every user):
--   oauth_client_id / oauth_client_secret_enc  a client registered by hand at the
--     authorization server; empty to register automatically (client ID metadata
--     document or dynamic client registration)
--   oauth_scope                                scopes to request; empty for the
--     scopes the server advertises
--   oauth_client_info_enc                      the client registration in use (JSON,
--     encrypted), set on the first sign-in
--
-- mcp_oauth_sessions holds one row per user and server: tokens, and the PKCE
-- verifier and state of a sign-in in progress (secrets encrypted by the app secret).
--
-- Rollback: DROP TABLE mcp_oauth_sessions; then ALTER TABLE mcp_servers DROP COLUMN for
-- auth, oauth_client_id, oauth_client_secret_enc, oauth_scope, oauth_client_info_enc.
ALTER TABLE mcp_servers ADD COLUMN auth TEXT NOT NULL DEFAULT 'token'
	CHECK (auth IN ('token', 'oauth'));
ALTER TABLE mcp_servers ADD COLUMN oauth_client_id TEXT;
ALTER TABLE mcp_servers ADD COLUMN oauth_client_secret_enc TEXT;
ALTER TABLE mcp_servers ADD COLUMN oauth_scope TEXT;
ALTER TABLE mcp_servers ADD COLUMN oauth_client_info_enc TEXT;

CREATE TABLE mcp_oauth_sessions (
	server_id TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
	user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
	tokens_enc TEXT,
	code_verifier_enc TEXT,
	state TEXT,
	auth_server_info TEXT,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (server_id, user_id)
);

CREATE UNIQUE INDEX idx_mcp_oauth_sessions_state ON mcp_oauth_sessions(state);
