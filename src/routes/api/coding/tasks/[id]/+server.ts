import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import { CODING_AUTONOMY_VALUES } from '$lib/coding-environments.js';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import {
	getCodingConversationForUser,
	toPublic
} from '$lib/server/db/repo/coding-conversations.js';
import { codingRoute } from '$lib/server/t3/http.js';
import { updateCodingTaskSettings } from '$lib/server/t3/tasks.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	const row = getCodingConversationForUser(getDb(), user.id, params.id);
	if (!row) error(404, { message: 'Coding task not found' });
	return json({ coding: toPublic(row) });
};

const patchSchema = z
	.object({
		providerInstanceId: z.string().min(1).max(200).optional(),
		model: z.string().min(1).max(200).optional(),
		autonomy: z.enum(CODING_AUTONOMY_VALUES).optional()
	})
	.refine((v) => !!v.providerInstanceId === !!v.model, {
		message: 'Choose a model and its provider together'
	});

/** Changes the task's model and/or autonomy (also on its T3 thread, once it exists). */
export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	const parsed = patchSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, { message: parsed.error.issues[0]?.message ?? 'Invalid body' });
	const row = await codingRoute(() => updateCodingTaskSettings(user.id, params.id, parsed.data));
	return json({ coding: toPublic(row) });
};
