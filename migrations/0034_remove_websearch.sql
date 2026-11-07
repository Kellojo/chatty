-- 0034_remove_websearch.sql
-- Removes the built-in SearXNG-backed web search MCP server and its settings.
-- Web search can be added back as a regular (remote) MCP server under Settings → MCP.
DELETE FROM mcp_servers WHERE id = 'builtin-websearch';
DELETE FROM settings WHERE key LIKE 'websearch.%';
