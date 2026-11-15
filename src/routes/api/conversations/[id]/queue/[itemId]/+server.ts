import { error, json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { remove } from '$lib/server/chat/queue.js';
import { getDb } from '$lib/server/db/index.js';
import { getConversation } from '$lib/server/db/repo/conversations.js';
import type { RequestHandler } from './$types';

/** Takes a message off the queue and returns it (e.g. to edit it). */
export const DELETE: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	const conversation = getConversation(getDb(), user.id, params.id);
	if (!conversation || conversation.kind !== 'chat') {
		error(404, { message: 'Conversation not found' });
	}
	const removed = remove(user.id, conversation.id, params.itemId);
	if (!removed) error(404, { message: 'The queued message was already sent' });
	return json(removed);
};
