import { json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import {
	CONVERSATIONS_PAGE_SIZE,
	countSettledConversations,
	listSettledConversations,
	toPublic
} from '$lib/server/db/repo/conversations.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals, url }) => {
	const user = requireUser(locals);
	const db = getDb();
	const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
	const limit = Math.min(
		200,
		Math.max(1, Number(url.searchParams.get('limit')) || CONVERSATIONS_PAGE_SIZE)
	);
	const rows = listSettledConversations(db, user.id, { offset, limit: limit + 1 });
	return json({
		conversations: rows.slice(0, limit).map(toPublic),
		hasMore: rows.length > limit,
		count: countSettledConversations(db, user.id)
	});
};
