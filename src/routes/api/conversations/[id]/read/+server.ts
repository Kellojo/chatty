import { error, json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import {
	getConversation,
	latestAssistantMessageAt,
	markConversationRead,
	setConversationReadAt
} from '$lib/server/db/repo/conversations.js';
import { queueThreadStatePush } from '$lib/server/t3/thread-state.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	const db = getDb();
	if (!getConversation(db, user.id, params.id)) {
		error(404, { message: 'Conversation not found' });
	}
	markConversationRead(db, user.id, params.id);
	queueThreadStatePush(db, user.id, [params.id]);
	return json({ ok: true });
};

/** Marks the conversation unread by moving its read marker just before the newest reply. */
export const DELETE: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	const db = getDb();
	if (!getConversation(db, user.id, params.id)) {
		error(404, { message: 'Conversation not found' });
	}
	const latest = latestAssistantMessageAt(db, params.id);
	if (latest === null) error(409, { message: 'Nothing to mark unread yet' });
	setConversationReadAt(db, user.id, params.id, latest - 1);
	queueThreadStatePush(db, user.id, [params.id]);
	return json({ ok: true });
};
