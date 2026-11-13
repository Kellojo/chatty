-- How many tools each MCP server listed the last time Chatty connected to it, shown in
-- Settings → MCP servers. NULL until the first connect.
--
-- Rollback: ALTER TABLE mcp_servers DROP COLUMN tool_count;
ALTER TABLE mcp_servers ADD COLUMN tool_count INTEGER;
