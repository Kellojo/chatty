import { error } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { getAgent, listAgentOverrides, toPublicWithOverrides } from '$lib/server/db/repo/agents.js';
import { listAgentRuns, toPublic as runToPublic } from '$lib/server/db/repo/agent-runs.js';
import { getTimeFormat } from '$lib/server/db/repo/user-settings.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, params }) => {
	const user = requireUser(locals);
	const db = getDb();
	const agent = getAgent(db, params.id);
	const isAdmin = (user as { role?: string }).role === 'admin';
	if (!agent || (agent.user_id !== null && agent.user_id !== user.id)) {
		error(404, { message: 'Agent not found' });
	}
	const showUser = agent.user_id === null && isAdmin;
	const runs = listAgentRuns(db, agent.id, 50, showUser ? undefined : user.id).map(runToPublic);
	// Where each run's transcript lives: a visible chat, the hidden run page, or
	// nowhere (its chat was deleted, or purged and unlinked).
	const transcripts: Record<string, 'chat' | 'run' | 'removed'> = {};
	const lookup = db.prepare('SELECT origin, deleted_at FROM conversations WHERE id = ?');
	for (const run of runs) {
		const row = run.conversationId
			? (lookup.get(run.conversationId) as
					{ origin: string; deleted_at: number | null } | undefined)
			: undefined;
		transcripts[run.id] =
			!row || row.deleted_at !== null ? 'removed' : row.origin === 'dispatch' ? 'chat' : 'run';
	}
	const users: Record<string, string> = {};
	if (showUser) {
		const ids = [...new Set(runs.map((r) => r.userId))];
		if (ids.length > 0) {
			const placeholders = ids.map(() => '?').join(', ');
			const rows = db
				.prepare(`SELECT id, name, email FROM "user" WHERE id IN (${placeholders})`)
				.all(...ids) as { id: string; name: string; email: string }[];
			for (const row of rows) users[row.id] = row.name || row.email;
		}
	}
	return {
		agent: toPublicWithOverrides(agent, listAgentOverrides(db, user.id)),
		runs,
		transcripts,
		users,
		showUser,
		timeFormat: getTimeFormat(db, user.id)
	};
};
