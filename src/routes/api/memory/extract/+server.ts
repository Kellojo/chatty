import { error, json } from '@sveltejs/kit';
import { startAgentRun } from '$lib/server/agents/runner.js';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { hasRunningAgentRun } from '$lib/server/db/repo/agent-runs.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals }) => {
	const user = requireUser(locals);
	const db = getDb();
	const agent = db
		.prepare("SELECT id FROM agents WHERE name = 'memory-extraction' AND user_id IS NULL")
		.get() as { id: string } | undefined;
	if (!agent) error(404, { message: 'Built-in memory-extraction agent not found' });
	// Overlapping extractions over the same chats would duplicate concepts and
	// let one user pile up model runs.
	if (hasRunningAgentRun(db, agent.id, user.id)) {
		error(409, { message: 'Memory extraction is already running' });
	}
	try {
		const { run, done } = await startAgentRun({
			agentId: agent.id,
			trigger: 'manual',
			userId: user.id
		});
		done.catch(() => undefined);
		return json({ runId: run.id });
	} catch (e) {
		error(400, { message: e instanceof Error ? e.message : 'Failed to start agent run' });
	}
};
