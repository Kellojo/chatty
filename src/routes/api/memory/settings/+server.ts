import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { setUserSetting } from '$lib/server/db/repo/user-settings.js';
import type { RequestHandler } from './$types';

const bodySchema = z.object({ strictMemoryPrivacy: z.boolean() });

/** Memory settings of the signed-in user (strict memory privacy). */
export const PUT: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	const parsed = bodySchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, { message: parsed.error.issues[0]?.message ?? 'Invalid body' });
	setUserSetting(getDb(), user.id, 'strictMemoryPrivacy', parsed.data.strictMemoryPrivacy);
	return json({ ok: true });
};
