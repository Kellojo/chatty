-- Private data. A provider or MCP server an admin trusts with private data
-- ("Can process private data" / "Allow in private chats"); conversations and
-- agents marked private; mappings that may only route to trusted providers.
-- Everything defaults to off, so nothing changes until someone opts in.
ALTER TABLE providers ADD COLUMN allow_private INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mcp_servers ADD COLUMN allow_private INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN private INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN private INTEGER NOT NULL DEFAULT 0;
ALTER TABLE model_mappings ADD COLUMN trusted_only INTEGER NOT NULL DEFAULT 0;
