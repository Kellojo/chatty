-- Personal MCP servers. A server with an owner is only offered to that user: their
-- chats, agent runs, Connected apps and API keys. NULL (every existing server) is
-- shared with everyone and managed by admins, as before. Deleting the user deletes
-- their servers (and, through mcp_servers, their OAuth sessions).
--
-- Rollback: DROP INDEX idx_mcp_servers_owner; ALTER TABLE mcp_servers DROP COLUMN owner_user_id;
ALTER TABLE mcp_servers ADD COLUMN owner_user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE;
CREATE INDEX idx_mcp_servers_owner ON mcp_servers(owner_user_id);
