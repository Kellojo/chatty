import { error, json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { draftHandoffPrompt } from '$lib/server/chat/handoff.js';
import { getDb } from '$lib/server/db/index.js';
import { getCodingConversation } from '$lib/server/db/repo/coding-conversations.js';
import { getConversation } from '$lib/server/db/repo/conversations.js';
import { createLogger } from '$lib/server/logger.js';
import type { RequestHandler } from './$types';

const log = createLogger('handoff');

/** Drafts a coding-agent task from a chat, for the user to review before starting it. */
export const POST: RequestHandler = async ({ locals, params }) => {
	const user = requireUser(locals);
	const db = getDb();
	const conversation = getConversation(db, user.id, params.id);
	if (!conversation || conversation.kind !== 'chat') {
		error(404, { message: 'Conversation not found' });
	}
	if (getCodingConversation(db, conversation.id)) {
		error(400, { message: 'This is already a coding task' });
	}
	try {
		return json({ prompt: await draftHandoffPrompt(user.id, conversation, db) });
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		log.warn('Hand-off draft failed', { conversationId: conversation.id, error: message });
		error(502, { message: `Could not draft the task: ${message}` });
	}
};
