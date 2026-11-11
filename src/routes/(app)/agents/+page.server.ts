import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import {
	listLatestAgentRuns,
	listRunningAgentIds,
	toPublic as runToPublic
} from '$lib/server/db/repo/agent-runs.js';
import {
	listAgentOverrides,
	listAgents,
	toPublicWithOverrides
} from '$lib/server/db/repo/agents.js';
import { getTimeFormat } from '$lib/server/db/repo/user-settings.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	const user = requireUser(locals);
	const db = getDb();
	const agents = listAgents(db, user.id);
	const overrides = listAgentOverrides(db, user.id);
	const ids = agents.map((a) => a.id);
	return {
		agents: agents.map((agent) => toPublicWithOverrides(agent, overrides)),
		runningAgentIds: listRunningAgentIds(db, ids),
		/** Each agent's latest run for this user, keyed by agent id. */
		lastRuns: Object.fromEntries(
			listLatestAgentRuns(db, ids, user.id).map((row) => [row.agent_id, runToPublic(row)])
		),
		timeFormat: getTimeFormat(db, user.id)
	};
};
