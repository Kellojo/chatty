-- Startup settles replies a previous process left 'partial'. Without an index
-- that filter scans every message, and `status` sits after the large `parts`
-- column, so the scan reads the whole table (well over 100 MB on a busy
-- install) on every start. Only a handful of rows are ever partial.
CREATE INDEX idx_messages_partial ON messages(status) WHERE status = 'partial';

-- Rollback:
--   DROP INDEX idx_messages_partial;
