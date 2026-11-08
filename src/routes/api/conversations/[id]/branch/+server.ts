import { json, error } from '@sveltejs/kit';
import { z } from 'zod';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { getConversation } from '$lib/server/db/repo/conversations.js';
import {
	activateBranch,
	listMessagesPage,
	toPublicWithBranches
} from '$lib/server/db/repo/messages.js';
import { hasActiveStream } from '$lib/server/chat/streams.js';
import { publishServerEvent } from '$lib/server/events/bus.js';
import type { RequestHandler } from './$types';

const bodySchema = z.object({ messageId: z.string().min(1) });

/**
 * Switches the conversation to the branch through `messageId` (one version of
 * an edited message or regenerated reply): its newest continuation becomes the
 * active path. Returns that path's newest page, like the chat page load.
 */
export const POST: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	const db = getDb();
	if (!getConversation(db, user.id, params.id)) error(404, { message: 'Conversation not found' });
	const parsed = bodySchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, { message: 'Invalid request body' });
	// The running reply belongs to the shown branch; switching away would send
	// the next message somewhere the user didn't see it continue.
	if (hasActiveStream(params.id)) error(409, { message: 'Wait for the reply to finish' });
	if (!activateBranch(db, params.id, parsed.data.messageId)) {
		error(400, { message: 'Unknown message id' });
	}
	publishServerEvent(user.id, { type: 'conversation.branch_changed', conversationId: params.id });
	const page = listMessagesPage(db, params.id)!;
	return json({
		messages: toPublicWithBranches(db, params.id, page.rows),
		hasOlder: page.hasOlder
	});
};
