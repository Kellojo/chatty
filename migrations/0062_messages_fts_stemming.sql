-- Rebuild messages_fts with stemming ("requests" matches "request") and
-- diacritic folding. FTS5 can't change a table's tokenizer in place, so the
-- table and its sync triggers are recreated, then filled from messages.
DROP TRIGGER messages_fts_insert;
DROP TRIGGER messages_fts_delete;
DROP TRIGGER messages_fts_update;
DROP TABLE messages_fts;

CREATE VIRTUAL TABLE messages_fts USING fts5(
  conversation_id UNINDEXED,
  content_text,
  content='messages',
  content_rowid='rowid',
  tokenize = 'porter unicode61 remove_diacritics 2'
);
CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, conversation_id, content_text)
  VALUES (new.rowid, new.conversation_id, new.content_text);
END;
CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, conversation_id, content_text)
  VALUES ('delete', old.rowid, old.conversation_id, old.content_text);
END;
CREATE TRIGGER messages_fts_update AFTER UPDATE OF content_text ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, conversation_id, content_text)
  VALUES ('delete', old.rowid, old.conversation_id, old.content_text);
  INSERT INTO messages_fts(rowid, conversation_id, content_text)
  VALUES (new.rowid, new.conversation_id, new.content_text);
END;

INSERT INTO messages_fts(messages_fts) VALUES ('rebuild');
