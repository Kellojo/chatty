-- Sites a user's tools actually fetched (webfetch source cards), with the favicon the
-- page declared. /api/favicon only serves icons for hosts listed here, so model output
-- can't make the server contact a hostname of its choosing (e.g. <chat data>.evil.com).
-- host is the page's hostname, lower-cased and without a leading "www.", matching the
-- host the ```links widget shows.
--
-- Rollback: DROP TABLE source_sites;
CREATE TABLE source_sites (
	user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
	host TEXT NOT NULL,
	origin TEXT NOT NULL,
	favicon_url TEXT,
	seen_at INTEGER NOT NULL,
	PRIMARY KEY (user_id, host)
);
