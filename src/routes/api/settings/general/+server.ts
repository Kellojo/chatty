import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import { requireAdmin } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { isPrivateDataEnabled, setPrivateDataEnabled } from '$lib/server/privacy/feature.js';
import type { RequestHandler } from './$types';

const bodySchema = z.object({
	/** Lets users mark chats, memory and agents private. */
	privateDataEnabled: z.boolean().optional()
});

/** App-wide settings an admin changes in Settings → General. */
export const PUT: RequestHandler = async ({ locals, request }) => {
	requireAdmin(locals);
	const parsed = bodySchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, { message: parsed.error.issues[0]?.message ?? 'Invalid body' });
	const db = getDb();
	if (parsed.data.privateDataEnabled !== undefined) {
		setPrivateDataEnabled(db, parsed.data.privateDataEnabled);
	}
	return json({ privateDataEnabled: isPrivateDataEnabled(db) });
};
