import { json, error } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { getConversation } from '$lib/server/db/repo/conversations.js';
import {
	listMessagesPage,
	MAX_MESSAGE_PAGE_SIZE,
	MESSAGE_PAGE_SIZE,
	toPublicWithBranches
} from '$lib/server/db/repo/messages.js';
import type { RequestHandler } from './$types';

/**
 * Pages backwards through a conversation's active branch: the newest `limit`
 * messages before the message `before` (or the newest overall), oldest to
 * newest. A `before` that is not on the active branch is a 400.
 */
export const GET: RequestHandler = ({ locals, params, url }) => {
	const user = requireUser(locals);
	const db = getDb();
	if (!getConversation(db, user.id, params.id)) error(404, { message: 'Conversation not found' });
	const rawLimit = url.searchParams.get('limit');
	let limit = MESSAGE_PAGE_SIZE;
	if (rawLimit !== null && rawLimit !== '') {
		limit = Number(rawLimit);
		if (!Number.isInteger(limit) || limit < 1) {
			error(400, { message: 'limit must be a positive integer' });
		}
		limit = Math.min(limit, MAX_MESSAGE_PAGE_SIZE);
	}
	const before = url.searchParams.get('before') || null;
	const page = listMessagesPage(db, params.id, { before, limit });
	if (!page) error(400, { message: 'Unknown message id in "before"' });
	return json({
		messages: toPublicWithBranches(db, params.id, page.rows),
		hasOlder: page.hasOlder
	});
};
