-- Seed the built-in image MCP server (AI SDK generateImage-backed image generation). Rollback: DELETE FROM mcp_servers WHERE id = 'builtin-image';
INSERT INTO mcp_servers (id, name, transport, builtin) VALUES ('builtin-image', 'image', 'builtin', 1);
