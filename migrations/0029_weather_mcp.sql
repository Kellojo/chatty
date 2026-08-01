-- Seed the bundled weather MCP server (Open-Meteo forecast; transport 'builtin'). Rollback: DELETE FROM mcp_servers WHERE id = 'builtin-weather';
INSERT INTO mcp_servers (id, name, transport, builtin) VALUES
	('builtin-weather', 'weather', 'builtin', 1);
