-- How an MCP server's tools reach the model: 'always' sends their definitions with every
-- request; 'deferred' keeps them out of the prompt until the model loads them through the
-- search_tools tool. Core builtins stay 'always'; niche builtins and external servers defer.
-- Rollback: ALTER TABLE mcp_servers DROP COLUMN load_mode;
ALTER TABLE mcp_servers ADD COLUMN load_mode TEXT NOT NULL DEFAULT 'always'
	CHECK (load_mode IN ('always', 'deferred'));

UPDATE mcp_servers SET load_mode = 'deferred'
WHERE builtin = 0 OR name IN ('math', 'weather', 'agents', 'settings', 'chat-search', 'wait');
