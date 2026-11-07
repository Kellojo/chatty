import { error } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { getAgent, toPublic as agentToPublic } from '$lib/server/db/repo/agents.js';
import { getAgentRun, toPublic as runToPublic } from '$lib/server/db/repo/agent-runs.js';
import { getCodingConversation } from '$lib/server/db/repo/coding-conversations.js';
import { listMessages, toPublic as messageToPublic } from '$lib/server/db/repo/messages.js';
import { getTimeFormat } from '$lib/server/db/repo/user-settings.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, params }) => {
	const user = requireUser(locals);
	const db = getDb();
	const run = getAgentRun(db, params.runId);
	if (!run || run.agent_id !== params.id) error(404, { message: 'Run not found' });
	const isAdmin = (user as { role?: string }).role === 'admin';
	if (run.user_id !== user.id && !isAdmin) error(404, { message: 'Run not found' });
	const agent = getAgent(db, run.agent_id);
	if (!agent) error(404, { message: 'Agent not found' });
	return {
		agent: agentToPublic(agent),
		run: runToPublic(run),
		messages: run.conversation_id ? listMessages(db, run.conversation_id).map(messageToPublic) : [],
		timeFormat: getTimeFormat(db, user.id),
		/** Coding agent runs live in a coding task conversation of their own. */
		isCodingTask: run.conversation_id ? !!getCodingConversation(db, run.conversation_id) : false
	};
};
