-- Every conversation runs in agent mode (tool use with the agent step budget) since
-- 0015 made it the default and nothing sets 'chat' any more, so drop the column.
-- Older 'chat' conversations now get the agent step budget too.
ALTER TABLE conversations DROP COLUMN mode;
