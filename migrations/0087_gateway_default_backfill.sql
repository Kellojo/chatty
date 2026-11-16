-- New API keys no longer get the chat-search and memory servers by default (they
-- hand past chats and notes to another app). Keys created before that, with no
-- explicit access (NULL = "the defaults"), keep what the defaults gave them: their
-- access is written out as an explicit list of every enabled server except the
-- builtins that were hidden by default then.
UPDATE api_keys
SET mcp_access = (
	SELECT json_group_array(json_object('serverId', s.id, 'tools', json('null')))
	FROM mcp_servers AS s
	WHERE s.enabled = 1
		AND NOT (
			s.builtin = 1
			AND s.name IN ('fs', 'code-exec', 'math', 'datetime', 'agents', 'subagents', 'coding')
		)
)
WHERE mcp_access IS NULL;
