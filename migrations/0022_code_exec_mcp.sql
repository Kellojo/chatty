-- Seed code-exec MCP server as builtin. Rollback: DELETE FROM mcp_servers WHERE id = 'builtin-code-exec';

INSERT OR IGNORE INTO mcp_servers (id, name, transport, builtin) VALUES
	('builtin-code-exec', 'code-exec', 'builtin', 1);
