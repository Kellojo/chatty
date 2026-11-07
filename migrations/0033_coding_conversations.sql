-- 0033_coding_conversations.sql
-- A coding task is a regular chat conversation (kind 'chat', so it shows up in the
-- sidebar, search, settling, ...) whose replies come from a thread on a remote
-- T3 Code server instead of Chatty's own model loop. This side table links the
-- conversation to that thread and caches its state.

CREATE TABLE coding_conversations (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  environment_id TEXT REFERENCES coding_environments(id) ON DELETE SET NULL,
  project_id TEXT NOT NULL,
  project_title TEXT NOT NULL,
  thread_id TEXT,                               -- NULL until the thread is created
  provider_instance_id TEXT NOT NULL,           -- T3 provider instance, e.g. 'codex'
  model TEXT NOT NULL,
  runtime_mode TEXT NOT NULL,                   -- T3 runtime mode literal
  workspace_mode TEXT NOT NULL DEFAULT 'worktree', -- 'worktree' | 'local'
  base_branch TEXT,
  branch TEXT,
  pr_url TEXT,
  status TEXT NOT NULL DEFAULT 'starting',
    -- starting | running | awaiting_input | idle | failed | interrupted
  pending_request TEXT,                         -- JSON: the approval/question waiting on the user
  last_sequence INTEGER,                        -- last T3 event sequence applied
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_coding_conversations_env ON coding_conversations(environment_id);
CREATE INDEX idx_coding_conversations_status ON coding_conversations(status);
