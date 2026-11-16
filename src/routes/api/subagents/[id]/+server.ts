import { error, json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { describeSubagent } from '$lib/server/agents/subagents.js';
import { getDb } from '$lib/server/db/index.js';
import { listMessages, toPublic as messageToPublic } from '$lib/server/db/repo/messages.js';
import type { RequestHandler } from './$types';

/** A subagent and its transcript. */
export const GET: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	const db = getDb();
	const subagent = describeSubagent(db, user.id, params.id);
	if (!subagent) error(404, { message: 'Subagent not found' });
	return json({ subagent, messages: listMessages(db, subagent.id).map(messageToPublic) });
};
