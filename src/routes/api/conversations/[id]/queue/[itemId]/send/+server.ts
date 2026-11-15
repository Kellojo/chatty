import { error, json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { sendNow } from '$lib/server/chat/queue.js';
import { ChatRequestError } from '$lib/server/chat/service.js';
import { getDb } from '$lib/server/db/index.js';
import { getConversation } from '$lib/server/db/repo/conversations.js';
import { getMessageQueue } from '$lib/server/db/repo/queued-messages.js';
import type { RequestHandler } from './$types';

/**
 * Sends a queued message now, interrupting a running reply, and resumes the
 * queue. The reply streams server-side; open chat views follow it.
 */
export const POST: RequestHandler = async ({ locals, params }) => {
	const user = requireUser(locals);
	const conversation = getConversation(getDb(), user.id, params.id);
	if (!conversation || conversation.kind !== 'chat') {
		error(404, { message: 'Conversation not found' });
	}
	try {
		await sendNow(user.id, conversation.id, params.itemId);
	} catch (e) {
		if (e instanceof ChatRequestError) error(e.status, { message: e.message });
		throw e;
	}
	return json(getMessageQueue(getDb(), conversation.id));
};
