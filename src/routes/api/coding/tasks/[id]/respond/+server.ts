import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import { requireUser } from '$lib/server/auth/guards.js';
import { codingRoute } from '$lib/server/t3/http.js';
import { respondToCodingRequest } from '$lib/server/t3/tasks.js';
import type { RequestHandler } from './$types';

// Ids come from the coding agent (T3 request ids, option values that may be the
// full option text) and are checked against the stored pending request, so the
// caps only guard against abuse rather than mirror an id format.
const respondSchema = z.object({
	requestId: z.string().min(1).max(4096),
	optionId: z.string().min(1).max(4096).optional(),
	text: z.string().max(10_000).optional()
});

/** Answers the approval or question the coding agent is waiting on. */
export const POST: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	const parsed = respondSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, { message: parsed.error.issues[0]?.message ?? 'Invalid body' });
	await codingRoute(() => respondToCodingRequest(user.id, params.id, parsed.data));
	return json({ ok: true });
};
