import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import { requireUser } from '$lib/server/auth/guards.js';
import { ChatRequestError, handleChatRequest } from '$lib/server/chat/service.js';
import type { RequestHandler } from './$types';
import type { UIMessage } from 'ai';

// User messages only carry text and file parts; the service additionally checks
// that file URLs point at this conversation's own attachments.
const userPartSchema = z.discriminatedUnion('type', [
	z.looseObject({ type: z.literal('text'), text: z.string() }),
	z.looseObject({
		type: z.literal('file'),
		url: z.string().min(1),
		mediaType: z.string().min(1),
		filename: z.string().optional()
	})
]);

const bodySchema = z.object({
	conversationId: z.string().min(1),
	message: z.looseObject({
		id: z.string().min(1),
		role: z.literal('user'),
		parts: z.array(userPartSchema)
	}),
	// The message this turn is a new version of: the edited user message, or the
	// reply being regenerated. Nothing is deleted; the new version becomes a
	// sibling of it. `truncateFrom` is the name older clients send.
	branchFrom: z.string().min(1).optional(),
	truncateFrom: z.string().min(1).optional(),
	skill: z.string().min(1).max(64).optional()
});

export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	const parsed = bodySchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, { message: 'Invalid request body' });
	try {
		return await handleChatRequest(user.id, {
			conversationId: parsed.data.conversationId,
			message: parsed.data.message as UIMessage,
			branchFrom: parsed.data.branchFrom ?? parsed.data.truncateFrom,
			skill: parsed.data.skill
		});
	} catch (e) {
		if (e instanceof ChatRequestError) error(e.status, { message: e.message });
		throw e;
	}
};

export const fallback: RequestHandler = () =>
	json({ message: 'Method not allowed' }, { status: 405 });
