-- Seed the bundled math MCP server (transport 'builtin'). Rollback: DELETE FROM mcp_servers WHERE id = 'builtin-math';
INSERT INTO mcp_servers (id, name, transport, builtin) VALUES
	('builtin-math', 'math', 'builtin', 1);
