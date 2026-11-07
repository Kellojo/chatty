-- 0031_coding_environments.sql
-- Remote T3 Code servers a user has connected ("coding environments"), plus the
-- provider usage Chatty syncs from them. Usage is a mirror of the remote server's
-- own numbers (subscription windows + per-model token/cost buckets) and is kept
-- separate from proxy_requests, which only records calls Chatty made itself.

CREATE TABLE coding_environments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  token_enc TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'unknown',       -- 'unknown' | 'online' | 'error'
  server_version TEXT,
  environment_label TEXT,                       -- name the remote server reports for itself
  last_error TEXT,
  last_checked_at INTEGER,
  last_synced_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_coding_environments_user ON coding_environments(user_id, created_at);

-- Latest known usage-limit windows per provider account (replaced on each sync).
CREATE TABLE coding_usage_limits (
  environment_id TEXT NOT NULL REFERENCES coding_environments(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,                     -- provider instance id on the remote server
  provider TEXT NOT NULL,                       -- driver kind, e.g. 'claudeAgent', 'codex'
  account_label TEXT NOT NULL,
  account_email TEXT,
  account_plan TEXT,
  window_id TEXT NOT NULL,
  window_kind TEXT NOT NULL,                    -- 'session' | 'weekly' | 'monthly' | 'other'
  window_label TEXT NOT NULL,
  used_percent REAL NOT NULL,
  resets_at INTEGER,
  checked_at INTEGER NOT NULL,
  PRIMARY KEY (environment_id, account_id, window_id)
);

-- Daily token/cost buckets per provider + model (replaced for the synced range).
CREATE TABLE coding_usage_daily (
  environment_id TEXT NOT NULL REFERENCES coding_environments(id) ON DELETE CASCADE,
  day TEXT NOT NULL,                            -- YYYY-MM-DD as reported by the server
  provider TEXT NOT NULL,                       -- 'claude' | 'codex' | ...
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,      -- uncached input
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,             -- API-equivalent estimate unless provider-reported
  priced INTEGER NOT NULL DEFAULT 1,            -- 0 when some records had no known price
  sessions INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (environment_id, day, provider, model)
);
