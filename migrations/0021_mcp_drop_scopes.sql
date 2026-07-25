-- Drop the mcp_servers.scopes column: all enabled servers are now available to every mode. Rollback: add the column back via ALTER TABLE mcp_servers ADD COLUMN scopes TEXT NOT NULL DEFAULT '["chat","agent"]';
CREATE TABLE mcp_servers_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  transport TEXT NOT NULL,
  command TEXT,
  args TEXT NOT NULL DEFAULT '[]',
  url TEXT,
  token_enc TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  builtin INTEGER NOT NULL DEFAULT 0
);

INSERT INTO mcp_servers_new (id, name, transport, command, args, url, token_enc, enabled, builtin)
SELECT id, name, transport, command, args, url, token_enc, enabled, builtin FROM mcp_servers;

DROP TABLE mcp_servers;
ALTER TABLE mcp_servers_new RENAME TO mcp_servers;
CREATE UNIQUE INDEX mcp_servers_name ON mcp_servers(name);
