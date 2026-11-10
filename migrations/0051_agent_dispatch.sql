-- Agent runs that can ask the user for input run as ordinary chats ("dispatched"
-- by Chatty). `origin` tells those apart from chats the user started, so loop
-- guards, memory extraction and "since" listings can leave them out.
ALTER TABLE conversations ADD COLUMN origin TEXT NOT NULL DEFAULT 'user'; -- 'user' | 'dispatch'

-- Whether an agent may ask the user questions: 'never' | 'approvals' | 'any'.
-- Existing agents (builtins included) stay 'never', i.e. hidden runs as before;
-- new user agents default to 'any' in createAgent.
ALTER TABLE agents ADD COLUMN can_ask TEXT NOT NULL DEFAULT 'never';

-- Resolving a conversation's run (resume, sidebar state, loop guards).
CREATE INDEX idx_agent_runs_conversation ON agent_runs(conversation_id);
