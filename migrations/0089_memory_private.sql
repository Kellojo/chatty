-- Private memory concepts: mirror the frontmatter `private: true` flag into
-- memory_fts, so searches can drop private concepts in SQL before ranking and
-- LIMIT. FTS5 can't add a column, so the table is recreated empty; the startup
-- reconcile in hooks.server.ts repopulates it from the files on disk.
DROP TABLE memory_fts;

CREATE VIRTUAL TABLE memory_fts USING fts5(
  scope UNINDEXED,                               -- 'user:<id>' | 'shared'
  path UNINDEXED,
  title,
  description,
  tags,
  body,
  private UNINDEXED,                             -- 1: frontmatter `private: true`
  tokenize = 'porter unicode61 remove_diacritics 2'
);
