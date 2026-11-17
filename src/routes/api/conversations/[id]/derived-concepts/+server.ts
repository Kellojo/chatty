import { error, json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { getConversation } from '$lib/server/db/repo/conversations.js';
import { derivedConcepts } from '$lib/server/privacy/derived-concepts.js';
import type { RequestHandler } from './$types';

/**
 * Memory concepts written from this chat, or by runs that read it: the "Make
 * private" dialog offers to mark them private too (best effort).
 */
export const GET: RequestHandler = async ({ locals, params }) => {
	const user = requireUser(locals);
	const db = getDb();
	if (!getConversation(db, user.id, params.id)) error(404, { message: 'Conversation not found' });
	return json({ concepts: await derivedConcepts(db, user.id, params.id) });
};
