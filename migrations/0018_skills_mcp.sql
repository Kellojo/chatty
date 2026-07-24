-- Seed the built-in skills MCP server (load_skill / read_skill_reference). Rollback: DELETE FROM mcp_servers WHERE id = 'builtin-skills';
INSERT INTO mcp_servers (id, name, transport, builtin) VALUES ('builtin-skills', 'skills', 'builtin', 1);
