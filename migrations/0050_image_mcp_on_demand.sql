-- Image generation answers explicit requests, so its large tool definitions load on demand.
-- Rollback: UPDATE mcp_servers SET load_mode = 'always' WHERE id = 'builtin-image';
UPDATE mcp_servers SET load_mode = 'deferred' WHERE id = 'builtin-image';
