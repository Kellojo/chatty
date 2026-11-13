-- How often the model comes across each memory concept, to learn which ones earn their place.
-- One row per concept, user, UTC day (YYYY-MM-DD) and caller, counted up on every view:
--   scope          'user' (the user's own bundle) or 'shared'
--   via            'chat' or 'agent' (an agent run)
--   search_hits    times the concept was among search_memory results
--   reads          times read_concept opened it
--   last_viewed_at the latest of either (epoch ms)
-- Aggregating per day keeps the table small without a cleanup job. Moving a concept carries
-- its rows to the new path; deleting it leaves them in place.
--
-- Rollback: DROP TABLE memory_views;
CREATE TABLE memory_views (
	scope TEXT NOT NULL,
	concept_path TEXT NOT NULL,
	user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
	day TEXT NOT NULL,
	via TEXT NOT NULL,
	search_hits INTEGER NOT NULL DEFAULT 0,
	reads INTEGER NOT NULL DEFAULT 0,
	last_viewed_at INTEGER NOT NULL,
	PRIMARY KEY (scope, concept_path, user_id, day, via)
);

CREATE INDEX idx_memory_views_day ON memory_views(day);
