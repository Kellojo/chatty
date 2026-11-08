-- 0042_coding_environment_remote_id.sql
-- The id a T3 Code server reports for itself (/.well-known/t3/environment), so the
-- same server can't be connected twice under different URLs (e.g. a tailnet name
-- and an IP). Not UNIQUE: rows connected before this migration may already be
-- duplicates; new duplicates are rejected by the API.

ALTER TABLE coding_environments ADD COLUMN remote_environment_id TEXT;
CREATE INDEX idx_coding_environments_remote ON coding_environments(user_id, remote_environment_id);
