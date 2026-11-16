-- Site icons served by /api/favicon, kept for a month so a restart doesn't refetch them.
-- Keyed by host (lower-cased, no leading "www.", as in source_sites) and shared by all
-- users: icons are public, and each user may still only ask for hosts in their own
-- source_sites. Rows older than a month are replaced on the next request and purged by
-- the daily jobs.
--
-- Rollback: DROP TABLE favicon_cache;
CREATE TABLE favicon_cache (
	host TEXT PRIMARY KEY,
	type TEXT NOT NULL,
	body BLOB NOT NULL,
	fetched_at INTEGER NOT NULL
);
