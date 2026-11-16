import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import { requireAdmin, requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { setConceptPathsPrivate, setConceptsPrivate } from '$lib/server/memory/bundle.js';
import type { RequestHandler } from './$types';

const bodySchema = z
	.object({
		scope: z.enum(['user', 'shared']).optional(),
		/** A folder of the bundle ('' for all of it). */
		prefix: z.string().optional(),
		/** Or these concepts (paths in the bundle). */
		paths: z.array(z.string().min(1).max(500)).min(1).max(500).optional(),
		private: z.boolean()
	})
	.refine((b) => (b.prefix === undefined) !== (b.paths === undefined), {
		message: 'Give either prefix or paths'
	});

/** A bundle path from the browser: forward slashes, no leading or trailing ones, no `.`/`..`. */
function cleanPath(value: string): string {
	const cleaned = value
		.split('\\')
		.join('/')
		.replace(/^\/+|\/+$/g, '');
	if (cleaned.split('/').some((s) => s === '.' || s === '..')) {
		error(400, { message: 'Invalid path' });
	}
	return cleaned;
}

/**
 * Marks every concept under a folder, or a list of concepts, private (or
 * public again). A person's action from the memory browser or the "Make
 * private" dialog; the shared bundle's flags are admin-only.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	const parsed = bodySchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, { message: parsed.error.issues[0]?.message ?? 'Invalid body' });
	const scope = parsed.data.scope === 'shared' ? 'shared' : 'user';
	const user = scope === 'shared' ? requireAdmin(locals) : requireUser(locals);
	const audit = { author: `user:${user.id}`, userId: user.id };
	const db = getDb();
	const updated = parsed.data.paths
		? await setConceptPathsPrivate(
				db,
				scope,
				user.id,
				parsed.data.paths.map(cleanPath),
				parsed.data.private,
				audit
			)
		: await setConceptsPrivate(
				db,
				scope,
				user.id,
				cleanPath(parsed.data.prefix ?? ''),
				parsed.data.private,
				audit
			);
	return json({ updated });
};
