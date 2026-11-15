-- Seed the bundled speech MCP server (transcribe_audio for uploaded audio files; transport
-- 'builtin'). It answers explicit requests, so its tools load on demand.
-- Rollback: DELETE FROM mcp_servers WHERE id = 'builtin-speech';
INSERT INTO mcp_servers (id, name, transport, builtin, load_mode) VALUES
	('builtin-speech', 'speech', 'builtin', 1, 'deferred');
