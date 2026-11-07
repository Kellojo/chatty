import { json, error } from '@sveltejs/kit';
import { stopCodingAgentRun } from '$lib/server/agents/coding-runs.js';
import { stopAgentRun } from '$lib/server/agents/runner.js';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { getAgentRun } from '$lib/server/db/repo/agent-runs.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	const db = getDb();
	const run = getAgentRun(db, params.id);
	if (!run || (run.user_id !== user.id && (user as { role?: string }).role !== 'admin')) {
		error(404, { message: 'Agent run not found' });
	}
	if (run.status !== 'running') {
		error(409, { message: 'Run is not running' });
	}
	if (!stopAgentRun(run.id) && !stopCodingAgentRun(run.id, db)) {
		error(409, { message: 'Run is not active on this server' });
	}
	return json({ ok: true });
};
