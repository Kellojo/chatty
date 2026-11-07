-- 0040_merge_duplicate_coding_threads.sql
-- The thread import used to check for already-imported threads per environment,
-- so a T3 thread was imported once more for every environment pointing at the
-- same T3 server (or after an environment was removed and added again). Each
-- copy's follower only wrote the messages no other copy owned yet, which left
-- the history split across the copies and some copies empty.
--
-- Merges every such group into one conversation: the keeper is the copy that is
-- not deleted, then linked to an environment, then imported first. The other
-- copies' messages and agent runs move to the keeper, then the copies are deleted.
-- Rollback: none (data repair).

CREATE TEMP TABLE _dup_coding AS
SELECT cc.conversation_id AS conversation_id,
       FIRST_VALUE(cc.conversation_id) OVER w AS keeper_id,
       ROW_NUMBER() OVER w AS rank
FROM coding_conversations cc
JOIN conversations c ON c.id = cc.conversation_id
WHERE cc.thread_id IS NOT NULL
WINDOW w AS (
  PARTITION BY c.user_id, cc.thread_id
  ORDER BY c.deleted_at IS NOT NULL, cc.environment_id IS NULL, cc.created_at, cc.conversation_id
);

DELETE FROM _dup_coding WHERE rank = 1;

UPDATE messages
SET conversation_id = (SELECT keeper_id FROM _dup_coding d WHERE d.conversation_id = messages.conversation_id)
WHERE conversation_id IN (SELECT conversation_id FROM _dup_coding);

UPDATE agent_runs
SET conversation_id = (SELECT keeper_id FROM _dup_coding d WHERE d.conversation_id = agent_runs.conversation_id)
WHERE conversation_id IN (SELECT conversation_id FROM _dup_coding);

-- Keep the most recent activity / read state and any pin of the merged copies.
UPDATE conversations
SET updated_at = MAX(updated_at, (SELECT MAX(c2.updated_at) FROM _dup_coding d JOIN conversations c2 ON c2.id = d.conversation_id WHERE d.keeper_id = conversations.id)),
    last_read_at = NULLIF(MAX(COALESCE(last_read_at, 0), COALESCE((SELECT MAX(c2.last_read_at) FROM _dup_coding d JOIN conversations c2 ON c2.id = d.conversation_id WHERE d.keeper_id = conversations.id), 0)), 0),
    pinned = MAX(pinned, (SELECT MAX(c2.pinned) FROM _dup_coding d JOIN conversations c2 ON c2.id = d.conversation_id WHERE d.keeper_id = conversations.id))
WHERE id IN (SELECT keeper_id FROM _dup_coding);

-- Cascades to the copies' coding_conversations rows (which records their thread
-- as dismissed for their environment) and conversation summaries.
DELETE FROM conversations WHERE id IN (SELECT conversation_id FROM _dup_coding);

DROP TABLE _dup_coding;
