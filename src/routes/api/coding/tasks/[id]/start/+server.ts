import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import {
	getCodingConversationForUser,
	setCodingDraftAutoStart,
	toPublic
} from '$lib/server/db/repo/coding-conversations.js';
import { publishServerEvent } from '$lib/server/events/bus.js';
import { startWaitingDrafts } from '$lib/server/t3/draft-starter.js';
import { codingRoute } from '$lib/server/t3/http.js';
import { startCodingDraft } from '$lib/server/t3/tasks.js';
import type { RequestHandler } from './$types';

/** Starts a draft task (saved while its environment was offline) with its first message. */
export const POST: RequestHandler = async ({ locals, params }) => {
	const user = requireUser(locals);
	const row = await codingRoute(() => startCodingDraft(user.id, params.id));
	return json({ coding: toPublic(row) });
};

const patchSchema = z.object({ autoStart: z.boolean() });

/** Whether the draft starts by itself once its environment is back online. */
export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	const parsed = patchSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, { message: 'Invalid body' });
	const db = getDb();
	if (!getCodingConversationForUser(db, user.id, params.id)) {
		error(404, { message: 'Coding task not found' });
	}
	if (!setCodingDraftAutoStart(db, params.id, parsed.data.autoStart)) {
		error(409, { message: 'This task was already started' });
	}
	publishServerEvent(user.id, { type: 'coding.task.updated', conversationId: params.id });
	// The environment may be back already.
	if (parsed.data.autoStart) void startWaitingDrafts().catch(() => undefined);
	const row = getCodingConversationForUser(db, user.id, params.id)!;
	return json({ coding: toPublic(row) });
};
