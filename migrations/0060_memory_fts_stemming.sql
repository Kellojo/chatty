-- Rebuild memory_fts with stemming ("tracker" matches "tracking", "hours" matches
-- "hour") and diacritic folding ("Grösse" matches "Grosse"). FTS5 can't change a
-- table's tokenizer in place, so the table is recreated empty; the startup
-- reconcile in hooks.server.ts repopulates it from the files on disk.
DROP TABLE memory_fts;

CREATE VIRTUAL TABLE memory_fts USING fts5(
  scope UNINDEXED,                               -- 'user:<id>' | 'shared'
  path UNINDEXED,
  title,
  description,
  tags,
  body,
  tokenize = 'porter unicode61 remove_diacritics 2'
);
