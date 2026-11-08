-- 0047_message_branches.sql
-- Non-destructive edit/regenerate: messages form a tree. Each message points at
-- the previous message on its path (NULL for a conversation's first message);
-- messages sharing a parent are alternative versions (siblings). The
-- conversation remembers the leaf of the branch it shows, and the active path
-- is the walk from that leaf up to the root.
--
-- parent_id deliberately has no foreign key: deleting a message keeps removing
-- only that message (as before), and the trigger below splices it out of the
-- tree instead of cascading to everything after it.

ALTER TABLE messages ADD COLUMN parent_id TEXT;
ALTER TABLE conversations ADD COLUMN active_leaf_id TEXT;

-- Existing histories are linear: each message's parent is the one before it.
UPDATE messages SET parent_id = prev.parent
FROM (
  SELECT id,
         LAG(id) OVER (PARTITION BY conversation_id ORDER BY created_at, rowid) AS parent
  FROM messages
) AS prev
WHERE prev.id = messages.id;

UPDATE conversations SET active_leaf_id = (
  SELECT m.id FROM messages m WHERE m.conversation_id = conversations.id
  ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1
);

-- Siblings and replies of a message, newest last.
CREATE INDEX idx_messages_parent ON messages(parent_id, created_at);
-- Walking a path reads only these columns, so it never touches the (large)
-- parts of the messages it passes.
CREATE INDEX idx_messages_tree ON messages(id, parent_id, conversation_id, created_at);

CREATE TRIGGER messages_branch_delete AFTER DELETE ON messages BEGIN
  UPDATE messages SET parent_id = old.parent_id WHERE parent_id = old.id;
  UPDATE conversations SET active_leaf_id = old.parent_id
  WHERE id = old.conversation_id AND active_leaf_id = old.id;
END;
