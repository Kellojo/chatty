-- Which memory notes the automatic privacy check has already looked at, by the
-- hash of what it read. The memory cleanup run checks notes that are new or
-- changed since; a note someone made public again stays public while its
-- content is unchanged.
CREATE TABLE memory_privacy_checks (
	scope TEXT NOT NULL,          -- 'user:<id>' | 'shared' (as in memory_fts)
	path TEXT NOT NULL,
	content_hash TEXT NOT NULL,
	checked_at INTEGER NOT NULL,
	PRIMARY KEY (scope, path)
);

-- The cleanup agent now does this sweep; say so where agents are listed.
UPDATE agents
SET description = 'Keeps long-term memory tidy on every 5th memory change: merges duplicates, resolves contradictions, prunes noise, and marks notes with personal information private (built-in).'
WHERE name = 'memory-cleanup' AND user_id IS NULL;
