import { json, error } from '@sveltejs/kit';
import { z } from 'zod';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import {
	getConversation,
	snoozeConversation,
	toPublic,
	unsnoozeConversation
} from '$lib/server/db/repo/conversations.js';
import { publishServerEvent } from '$lib/server/events/bus.js';
import { queueThreadStatePush } from '$lib/server/t3/thread-state.js';
import { MAX_SNOOZE_MS } from '$lib/snooze.js';
import type { RequestHandler } from './$types';

const snoozeSchema = z.object({ until: z.number().int() });

/** Snoozes the conversation until `until` (ms): it leaves the active list until then. */
export const POST: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	const parsed = snoozeSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, { message: 'Expected { until: number }' });
	const now = Date.now();
	const { until } = parsed.data;
	if (until <= now) error(400, { message: 'Snooze time must be in the future' });
	if (until > now + MAX_SNOOZE_MS) error(400, { message: 'Snooze time is too far ahead' });
	const db = getDb();
	const existing = getConversation(db, user.id, params.id);
	if (!existing) error(404, { message: 'Conversation not found' });
	if (existing.settled_at !== null)
		error(409, { message: 'Settled conversations cannot be snoozed' });
	const conversation = snoozeConversation(db, user.id, params.id, until, now)!;
	queueThreadStatePush(db, user.id, [conversation.id]);
	publishServerEvent(user.id, {
		type: 'conversation.snooze_changed',
		conversationIds: [conversation.id],
		snoozed: true
	});
	return json({ conversation: toPublic(conversation) });
};

/** Wakes the conversation now. */
export const DELETE: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	const db = getDb();
	if (!getConversation(db, user.id, params.id)) error(404, { message: 'Conversation not found' });
	if (unsnoozeConversation(db, user.id, params.id)) {
		queueThreadStatePush(db, user.id, [params.id]);
		publishServerEvent(user.id, {
			type: 'conversation.snooze_changed',
			conversationIds: [params.id],
			snoozed: false
		});
	}
	return json({ conversation: toPublic(getConversation(db, user.id, params.id)!) });
};
