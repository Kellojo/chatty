-- Private chats keep every tool, so MCP servers no longer need an
-- "Allow in private chats" flag (added in 0088).
ALTER TABLE mcp_servers DROP COLUMN allow_private;
