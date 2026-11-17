import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { getCodingConversation } from '$lib/server/db/repo/coding-conversations.js';
import {
	getConversation,
	setConversationPrivate,
	setConversationTitle
} from '$lib/server/db/repo/conversations.js';
import { publishServerEvent } from '$lib/server/events/bus.js';
import { privatePlaceholderTitle } from '$lib/server/privacy/background.js';
import { hasTrustedProvider } from '$lib/server/privacy/policy.js';
import type { RequestHandler } from './$types';

const bodySchema = z.object({
	ids: z.array(z.string().min(1)).min(1).max(200),
	/** Replace each chat's title with a placeholder too (see PATCH /api/conversations/[id]). */
	replaceTitle: z.boolean().optional()
});

type Skipped = { id: string; reason: 'not-found' | 'coding' | 'already-private' };

/**
 * Makes several chats private at once (the chat list's multi-select). Turning
 * privacy on is always allowed; coding chats can never be private and are
 * skipped, like chats that are gone or already private.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	const parsed = bodySchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, { message: parsed.error.issues[0]?.message ?? 'Invalid body' });
	const db = getDb();
	if (!hasTrustedProvider(db)) error(409, { message: 'No provider may process private data yet' });
	const updated: string[] = [];
	const skipped: Skipped[] = [];
	for (const id of new Set(parsed.data.ids)) {
		const conversation = getConversation(db, user.id, id);
		if (!conversation) {
			skipped.push({ id, reason: 'not-found' });
			continue;
		}
		if (getCodingConversation(db, id)) {
			skipped.push({ id, reason: 'coding' });
			continue;
		}
		if (!setConversationPrivate(db, id, true)) {
			skipped.push({ id, reason: 'already-private' });
			continue;
		}
		if (parsed.data.replaceTitle) setConversationTitle(db, id, privatePlaceholderTitle());
		updated.push(id);
		publishServerEvent(user.id, {
			type: 'conversation.privacy',
			conversationId: id,
			private: true
		});
	}
	return json({ updated, skipped });
};
