-- Estimated prompt tokens of each MCP server's tool definitions (names, descriptions and
-- input schemas), recorded with tool_count on every listing. Shown as the tool context
-- chart in Settings → MCP servers. NULL until the first connect.
--
-- Rollback: ALTER TABLE mcp_servers DROP COLUMN tool_tokens;
ALTER TABLE mcp_servers ADD COLUMN tool_tokens INTEGER;
