-- The MCP gateway (/api/mcp) serves Chatty's MCP servers to outside clients (e.g. Claude Code)
-- that authenticate with an API key holding the `mcp:use` scope.
--
-- mcp_gateway_servers: which servers a user exposes through the gateway. Only choices that
-- differ from the default (see src/lib/server/db/repo/mcp-gateway.ts) are stored.
--
-- mcp_gateway_usage: gateway tool calls, one row per API key, server, tool and UTC day
-- (YYYY-MM-DD), counted up on every call (calls, errors, total_ms, last_used_at as in
-- mcp_tool_usage). api_key_id has no foreign key, so a deleted key's history stays.
--
-- Rollback: DROP TABLE mcp_gateway_usage; DROP TABLE mcp_gateway_servers;
CREATE TABLE mcp_gateway_servers (
	user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
	server_id TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
	exposed INTEGER NOT NULL,
	PRIMARY KEY (user_id, server_id)
);

CREATE TABLE mcp_gateway_usage (
	api_key_id TEXT NOT NULL,
	user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
	server_id TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
	tool_name TEXT NOT NULL,
	day TEXT NOT NULL,
	calls INTEGER NOT NULL DEFAULT 0,
	errors INTEGER NOT NULL DEFAULT 0,
	total_ms INTEGER NOT NULL DEFAULT 0,
	last_used_at INTEGER NOT NULL,
	PRIMARY KEY (api_key_id, server_id, tool_name, day)
);

CREATE INDEX idx_mcp_gateway_usage_user_day ON mcp_gateway_usage(user_id, day);
