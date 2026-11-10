import { json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { listActiveStreams } from '$lib/server/chat/streams.js';
import { getDb } from '$lib/server/db/index.js';
import { getConversation } from '$lib/server/db/repo/conversations.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals }) => {
	const user = requireUser(locals);
	const db = getDb();
	// Hidden agent runs stream through the same registry but aren't chats.
	const streams = listActiveStreams().filter(
		(s) => getConversation(db, user.id, s.conversationId)?.kind === 'chat'
	);
	return json({ conversationIds: streams.map((s) => s.conversationId), streams });
};
