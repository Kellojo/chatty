-- Track model context window size for auto-compaction. Rollback: not supported (SQLite column drop).
ALTER TABLE models ADD COLUMN context_length INTEGER;
