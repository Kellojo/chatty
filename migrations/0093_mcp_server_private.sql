-- Private MCP servers: their tools return private data, so they are only offered
-- to turns whose every model is on a provider trusted with private data, and a
-- call taints the turn (its chat becomes private). Never offered to the MCP
-- gateway or other callers that can't record taint. Off for every existing server.
--
-- Rollback: ALTER TABLE mcp_servers DROP COLUMN private;
ALTER TABLE mcp_servers ADD COLUMN private INTEGER NOT NULL DEFAULT 0;
