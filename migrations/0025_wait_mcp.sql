-- Seed the built-in wait MCP server (pause execution and check back later). Rollback: DELETE FROM mcp_servers WHERE id = 'builtin-wait';
INSERT INTO mcp_servers (id, name, transport, builtin) VALUES ('builtin-wait', 'wait', 'builtin', 1);
