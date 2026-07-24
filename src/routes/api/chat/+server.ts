import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import { requireUser } from '$lib/server/auth/guards.js';
import { ChatRequestError, handleChatRequest } from '$lib/server/chat/service.js';
import type { RequestHandler } from './$types';
import type { UIMessage } from 'ai';

const bodySchema = z.object({
	conversationId: z.string().min(1),
	messages: z.array(z.looseObject({ id: z.string(), role: z.string(), parts: z.array(z.any()) })),
	skill: z.string().min(1).max(64).optional()
});

export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	const parsed = bodySchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, { message: 'Invalid request body' });
	try {
		return await handleChatRequest(user.id, {
			conversationId: parsed.data.conversationId,
			messages: parsed.data.messages as UIMessage[],
			skill: parsed.data.skill
		});
	} catch (e) {
		if (e instanceof ChatRequestError) error(e.status, { message: e.message });
		throw e;
	}
};

export const fallback: RequestHandler = () =>
	json({ message: 'Method not allowed' }, { status: 405 });
