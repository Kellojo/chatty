import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import { requireAdmin, requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { setConceptsPrivate } from '$lib/server/memory/bundle.js';
import type { RequestHandler } from './$types';

const bodySchema = z.object({
	scope: z.enum(['user', 'shared']).optional(),
	/** A folder of the bundle ('' for all of it). */
	prefix: z.string(),
	private: z.boolean()
});

/**
 * Marks every concept under a folder private (or public again). A person's
 * action from the memory browser; the shared bundle's flags are admin-only.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	const parsed = bodySchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, { message: parsed.error.issues[0]?.message ?? 'Invalid body' });
	const scope = parsed.data.scope === 'shared' ? 'shared' : 'user';
	const user = scope === 'shared' ? requireAdmin(locals) : requireUser(locals);
	const prefix = parsed.data.prefix
		.split('\\')
		.join('/')
		.replace(/^\/+|\/+$/g, '');
	if (prefix.split('/').some((s) => s === '.' || s === '..')) {
		error(400, { message: 'Invalid folder' });
	}
	const updated = await setConceptsPrivate(getDb(), scope, user.id, prefix, parsed.data.private, {
		author: `user:${user.id}`,
		userId: user.id
	});
	return json({ updated });
};
