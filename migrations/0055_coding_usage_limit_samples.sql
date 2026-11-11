-- 0055_coding_usage_limit_samples.sql
-- History of plan-limit usage, one sample per window per sync, so the Usage page
-- can draw a burn-down for the current window and project where it will end.
-- coding_usage_limits keeps only the latest snapshot; old samples are pruned.

CREATE TABLE coding_usage_limit_samples (
  environment_id TEXT NOT NULL REFERENCES coding_environments(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  window_id TEXT NOT NULL,
  sampled_at INTEGER NOT NULL,                  -- checked_at of the snapshot
  used_percent REAL NOT NULL,
  resets_at INTEGER,
  PRIMARY KEY (environment_id, account_id, window_id, sampled_at)
);
CREATE INDEX idx_coding_usage_limit_samples_time ON coding_usage_limit_samples(sampled_at);
