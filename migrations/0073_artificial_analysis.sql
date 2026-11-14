-- Cached Artificial Analysis model list (Intelligence Index). Replaced wholesale on
-- each refresh; matched to local models at read time, so new models need no refetch.
CREATE TABLE aa_models (
  id TEXT PRIMARY KEY,                 -- Artificial Analysis uuid (slugs may change)
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  creator TEXT,
  intelligence_index REAL,
  release_date TEXT,
  fetched_at INTEGER NOT NULL
);
