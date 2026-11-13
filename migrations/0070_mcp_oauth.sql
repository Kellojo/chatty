-- OAuth 2.1 for the MCP gateway, so MCP clients such as Claude Code can sign in instead of
-- taking a pasted API key. Each approval is an API key (scope mcp:use) linked to the client,
-- so it shows, is edited and is revoked like any other key; tokens die with it.
--
-- oauth_clients: clients registered through dynamic client registration (RFC 7591); all
--   public (PKCE, no secret). redirect_uris is a JSON array. approved_at is set once a user
--   approves the client; registrations nobody approved are purged after a day.
-- oauth_codes:   single-use authorization codes (stored as SHA-256), valid for minutes.
-- oauth_tokens:  access and refresh tokens (stored as SHA-256). Refresh tokens rotate.
-- api_keys.oauth_client_id: the client a key was approved for; NULL for keys made by hand.
--
-- Rollback: DROP TABLE oauth_tokens; DROP TABLE oauth_codes;
--   ALTER TABLE api_keys DROP COLUMN oauth_client_id; DROP TABLE oauth_clients;
CREATE TABLE oauth_clients (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	redirect_uris TEXT NOT NULL,
	client_uri TEXT,
	created_at INTEGER NOT NULL,
	approved_at INTEGER
);

CREATE TABLE oauth_codes (
	code_hash TEXT PRIMARY KEY,
	client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
	api_key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
	redirect_uri TEXT NOT NULL,
	code_challenge TEXT NOT NULL,
	expires_at INTEGER NOT NULL
);

CREATE TABLE oauth_tokens (
	token_hash TEXT PRIMARY KEY,
	kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
	api_key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
	client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
	expires_at INTEGER NOT NULL,
	created_at INTEGER NOT NULL
);

CREATE INDEX idx_oauth_tokens_key ON oauth_tokens(api_key_id);

ALTER TABLE api_keys ADD COLUMN oauth_client_id TEXT REFERENCES oauth_clients(id) ON DELETE SET NULL;
