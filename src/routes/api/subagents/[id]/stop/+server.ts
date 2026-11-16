import { error, json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { describeSubagent } from '$lib/server/agents/subagents.js';
import { abortStream } from '$lib/server/chat/streams.js';
import { getDb } from '$lib/server/db/index.js';
import type { RequestHandler } from './$types';

/** Stops a working subagent; its parent gets the report "stopped". */
export const POST: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	const subagent = describeSubagent(getDb(), user.id, params.id);
	if (!subagent) error(404, { message: 'Subagent not found' });
	const stopped = subagent.status === 'running' && abortStream(subagent.id, 'stopped');
	return json({ stopped });
};
