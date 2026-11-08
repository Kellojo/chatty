import { error, json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { findThreadConversationForUser } from '$lib/server/db/repo/coding-conversations.js';
import type { RequestHandler } from './$types';

/** The conversation (and its title) of a T3 thread, for labelling thread links. */
export const GET: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	const found = findThreadConversationForUser(
		getDb(),
		user.id,
		params.environmentId,
		params.threadId
	);
	if (!found) error(404, { message: 'Thread not found' });
	return json(found);
};
