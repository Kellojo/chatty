-- Replace the built-in bash and documents MCP servers with a single fs server (fs_read/fs_write/...). Rollback: DELETE FROM mcp_servers WHERE id = 'builtin-fs'; re-add builtin-bash and builtin-documents.
INSERT INTO mcp_servers (id, name, transport, enabled, scopes, builtin)
VALUES ('builtin-fs', 'fs', 'builtin', 1, '["chat","agent"]', 1);

DELETE FROM mcp_servers WHERE id IN ('builtin-bash', 'builtin-documents');
