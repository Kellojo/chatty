-- Brings back the built-in web_search tool (removed in 0034), now backed by the providers
-- configured in Settings → Services (SearXNG, Brave Search, Perplexity). Always loaded, but it is
-- only offered to models once a provider is configured (see tools/registry.ts).
-- A user-added server already named "websearch" (0034 suggested adding one) is renamed,
-- since server names are unique; its id, tools and API key grants are unchanged.
--
-- Rollback: DELETE FROM mcp_servers WHERE id = 'builtin-websearch';
-- DELETE FROM settings WHERE key LIKE 'websearch.%';
UPDATE mcp_servers SET name = 'websearch-custom' WHERE name = 'websearch' AND builtin = 0;

INSERT OR IGNORE INTO mcp_servers (id, name, transport, builtin, load_mode, enabled)
VALUES ('builtin-websearch', 'websearch', 'builtin', 1, 'always', 1);
