import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import { requireUser } from '$lib/server/auth/guards.js';
import { enqueue, setPaused } from '$lib/server/chat/queue.js';
import { ChatRequestError } from '$lib/server/chat/service.js';
import { getDb } from '$lib/server/db/index.js';
import { getConversation } from '$lib/server/db/repo/conversations.js';
import { getMessageQueue } from '$lib/server/db/repo/queued-messages.js';
import type { RequestHandler } from './$types';

const MAX_TEXT_LENGTH = 200_000;

const fileSchema = z.object({
	type: z.literal('file'),
	url: z.string().min(1),
	mediaType: z.string().min(1),
	filename: z.string()
});

const postSchema = z
	.object({
		text: z.string().max(MAX_TEXT_LENGTH),
		files: z.array(fileSchema).max(50).default([])
	})
	.refine((m) => m.text.trim() !== '' || m.files.length > 0, 'The message is empty');

const patchSchema = z.object({ paused: z.boolean() });

function requireChat(userId: string, conversationId: string) {
	const conversation = getConversation(getDb(), userId, conversationId);
	if (!conversation || conversation.kind !== 'chat') {
		error(404, { message: 'Conversation not found' });
	}
	return conversation;
}

export const GET: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	const conversation = requireChat(user.id, params.id);
	return json(getMessageQueue(getDb(), conversation.id));
};

/** Queues a message (its files already uploaded as attachments). */
export const POST: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	const conversation = requireChat(user.id, params.id);
	const parsed = postSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, { message: 'Invalid request body' });
	try {
		return json(enqueue(user.id, conversation.id, parsed.data), { status: 201 });
	} catch (e) {
		if (e instanceof ChatRequestError) error(e.status, { message: e.message });
		throw e;
	}
};

/** Pauses or resumes the queue. */
export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	const conversation = requireChat(user.id, params.id);
	const parsed = patchSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, { message: 'Invalid request body' });
	return json(setPaused(user.id, conversation.id, parsed.data.paused));
};
