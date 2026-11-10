import { json, error } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import {
	settleConversation,
	toPublic,
	unsettleConversation
} from '$lib/server/db/repo/conversations.js';
import {
	onRunConversationSettled,
	onRunConversationUnsettled
} from '$lib/server/agents/run-lifecycle.js';
import { publishServerEvent } from '$lib/server/events/bus.js';
import { queueThreadStatePush } from '$lib/server/t3/thread-state.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	const db = getDb();
	const conversation = settleConversation(db, user.id, params.id, 'manual');
	if (!conversation) error(404, { message: 'Conversation not found' });
	// Settling a chat whose agent waits for an answer means "never mind".
	onRunConversationSettled(db, user.id, conversation.id);
	queueThreadStatePush(db, user.id, [conversation.id]);
	publishServerEvent(user.id, {
		type: 'conversation.settle_changed',
		conversationIds: [conversation.id],
		settled: true
	});
	return json({ conversation: toPublic(conversation) });
};

export const DELETE: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	const db = getDb();
	const conversation = unsettleConversation(db, user.id, params.id);
	if (!conversation) error(404, { message: 'Conversation not found' });
	// ...and bringing it back means the question stands again.
	onRunConversationUnsettled(db, user.id, conversation.id);
	queueThreadStatePush(db, user.id, [conversation.id]);
	publishServerEvent(user.id, {
		type: 'conversation.settle_changed',
		conversationIds: [conversation.id],
		settled: false
	});
	return json({ conversation: toPublic(conversation) });
};
