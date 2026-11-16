-- Regroups the bundled MCP servers:
--  * settings is removed (its few keys all have their own UI).
--  * wait is merged into datetime (now, convert, wait), which is always loaded.
--  * math is always loaded, so models use it instead of writing code for arithmetic.
--  * agents is split: run_subagent moves to `subagents` (always loaded) and
--    list_coding_projects/propose_coding_task to `coding` (on demand). Both start
--    out enabled or disabled like agents.
-- API keys that granted the removed servers lose them (dropped from mcp_access below);
-- subagents and coding need a conversation, so keys don't get them.
--
-- Rollback: DELETE FROM mcp_servers WHERE id IN ('builtin-subagents', 'builtin-coding');
-- re-insert ('builtin-wait', 'wait') and ('builtin-settings', 'settings') as builtin rows
-- with load_mode 'deferred'; UPDATE mcp_servers SET load_mode = 'deferred' WHERE id = 'builtin-math'.
-- Removed API key grants are not restored.
DELETE FROM mcp_servers WHERE id IN ('builtin-settings', 'builtin-wait');

UPDATE mcp_servers SET load_mode = 'always' WHERE id IN ('builtin-datetime', 'builtin-math');

INSERT INTO mcp_servers (id, name, transport, builtin, load_mode, enabled)
SELECT 'builtin-subagents', 'subagents', 'builtin', 1, 'always',
	COALESCE((SELECT enabled FROM mcp_servers WHERE id = 'builtin-agents'), 1);

INSERT INTO mcp_servers (id, name, transport, builtin, load_mode, enabled)
SELECT 'builtin-coding', 'coding', 'builtin', 1, 'deferred',
	COALESCE((SELECT enabled FROM mcp_servers WHERE id = 'builtin-agents'), 1);

UPDATE api_keys
SET mcp_access = (
	SELECT json_group_array(json(e.value))
	FROM json_each(api_keys.mcp_access) AS e
	WHERE json_extract(e.value, '$.serverId') NOT IN ('builtin-settings', 'builtin-wait')
)
WHERE mcp_access IS NOT NULL AND json_valid(mcp_access);
