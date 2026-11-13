-- Usage of MCP tools, so admins can see which servers earn their place.
-- One row per server, tool, user and UTC day (YYYY-MM-DD), counted up on every call:
--   calls        tool calls made
--   errors       calls that threw or returned an MCP error result
--   total_ms     summed duration of those calls
--   last_used_at the latest call (epoch ms)
-- Aggregating per day keeps the table small without a cleanup job.
--
-- Rollback: DROP TABLE mcp_tool_usage;
CREATE TABLE mcp_tool_usage (
	server_id TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
	tool_name TEXT NOT NULL,
	user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
	day TEXT NOT NULL,
	calls INTEGER NOT NULL DEFAULT 0,
	errors INTEGER NOT NULL DEFAULT 0,
	total_ms INTEGER NOT NULL DEFAULT 0,
	last_used_at INTEGER NOT NULL,
	PRIMARY KEY (server_id, tool_name, user_id, day)
);

CREATE INDEX idx_mcp_tool_usage_day ON mcp_tool_usage(day);
