import { error, json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { abortStream } from '$lib/server/chat/streams.js';
import { getDb } from '$lib/server/db/index.js';
import { getConversation } from '$lib/server/db/repo/conversations.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	if (!getConversation(getDb(), user.id, params.id)) {
		error(404, { message: 'Conversation not found' });
	}
	return json({ aborted: abortStream(params.id) });
};
