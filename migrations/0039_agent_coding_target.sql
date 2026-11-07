-- Coding agents: when set, a run of this agent is a T3 coding task instead of a
-- model loop. JSON AgentCodingTarget (environment, project, model, autonomy,
-- workspace). It is kept when the environment is removed so the agent fails
-- its runs instead of silently turning into a model agent.
ALTER TABLE agents ADD COLUMN coding_target TEXT;
