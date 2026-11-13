-- MCP gateway access moves from a per-user server list to each API key.
-- api_keys.mcp_access: JSON array of { "serverId": string, "tools": string[] | null } —
-- the servers a key with the `mcp:use` scope may use, each with all of its tools (null, so
-- tools a server adds later are included) or only the listed ones. NULL means the default
-- servers (see src/lib/server/db/repo/mcp-gateway.ts), with all their tools.
--
-- Rollback: ALTER TABLE api_keys DROP COLUMN mcp_access; then recreate mcp_gateway_servers
-- as in 0068_mcp_gateway.sql.
ALTER TABLE api_keys ADD COLUMN mcp_access TEXT;

DROP TABLE mcp_gateway_servers;
