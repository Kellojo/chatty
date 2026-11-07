import { error } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { createStreamReplayResponse } from '$lib/server/chat/replay.js';
import { getDb } from '$lib/server/db/index.js';
import { getConversation } from '$lib/server/db/repo/conversations.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	const conversation = getConversation(getDb(), user.id, params.id);
	if (!conversation) error(404, { message: 'Conversation not found' });
	return createStreamReplayResponse(params.id) ?? new Response(null, { status: 204 });
};
