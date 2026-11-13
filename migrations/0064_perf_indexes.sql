-- Indexes for hot read paths found in a performance review.
--
-- The admin sidebar counts running proxy requests on every request start/finish;
-- a partial index keeps that a tiny covering lookup instead of a table scan.
CREATE INDEX idx_proxy_requests_running ON proxy_requests(status) WHERE status = 'running';

-- The sidebar picks each conversation's latest agent run (ORDER BY started_at DESC
-- LIMIT 1); with started_at in the index that needs no temp sort. It replaces the
-- single-column index from 0051, which is its prefix.
CREATE INDEX idx_agent_runs_conversation_started ON agent_runs(conversation_id, started_at);
DROP INDEX idx_agent_runs_conversation;

-- Conversations whose agent run waits for the user's answer.
CREATE INDEX idx_agent_runs_awaiting ON agent_runs(conversation_id) WHERE status = 'awaiting_input';

-- An agent's last finished run per user (activity since the last run).
CREATE INDEX idx_agent_runs_agent_user_ended ON agent_runs(agent_id, user_id, ended_at);

-- Rollback:
--   DROP INDEX idx_proxy_requests_running;
--   DROP INDEX idx_agent_runs_conversation_started;
--   CREATE INDEX idx_agent_runs_conversation ON agent_runs(conversation_id);
--   DROP INDEX idx_agent_runs_awaiting;
--   DROP INDEX idx_agent_runs_agent_user_ended;
