import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import { requireAdmin, requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { getMemoryViewTotals } from '$lib/server/db/repo/memory-views.js';
import {
	deleteConcept,
	moveConcept,
	readConcept,
	writeConcept
} from '$lib/server/memory/bundle.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, url }) => {
	const scope = url.searchParams.get('scope') === 'shared' ? 'shared' : 'user';
	const user = scope === 'shared' ? requireAdmin(locals) : requireUser(locals);
	const path = url.searchParams.get('path') ?? '';
	const concept = path ? await readConcept(scope, user.id, path) : null;
	if (!concept) error(404, { message: 'Concept not found' });
	const views = getMemoryViewTotals(getDb(), scope, concept.path, user.id);
	return json({ concept, views });
};

const putSchema = z.object({
	scope: z.enum(['user', 'shared']).optional(),
	path: z.string().min(1),
	newPath: z.string().min(1).optional(),
	frontmatter: z.object({
		title: z.string().min(1),
		type: z.string().optional(),
		description: z.string().optional(),
		tags: z.array(z.string()).optional()
	}),
	body: z.string()
});

export const PUT: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	const parsed = putSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, { message: parsed.error.issues[0]?.message ?? 'Invalid body' });
	const data = parsed.data;
	const scope = data.scope === 'shared' ? 'shared' : 'user';
	if (scope === 'shared') requireAdmin(locals);
	const audit = { author: `user:${user.id}`, userId: user.id };
	const db = getDb();
	try {
		const concept =
			data.newPath !== undefined && data.newPath !== data.path
				? await moveConcept(db, scope, user.id, data.path, data.newPath, audit)
				: await writeConcept(
						db,
						scope,
						user.id,
						data.path,
						{ frontmatter: data.frontmatter, body: data.body },
						audit
					);
		return json({ concept });
	} catch (e) {
		error(400, { message: e instanceof Error ? e.message : 'Invalid concept' });
	}
};

export const DELETE: RequestHandler = async ({ locals, url }) => {
	const scope = url.searchParams.get('scope') === 'shared' ? 'shared' : 'user';
	const user = scope === 'shared' ? requireAdmin(locals) : requireUser(locals);
	const path = url.searchParams.get('path') ?? '';
	let deleted: boolean;
	try {
		deleted =
			!!path &&
			(await deleteConcept(getDb(), scope, user.id, path, {
				author: `user:${user.id}`,
				userId: user.id
			}));
	} catch {
		deleted = false;
	}
	if (!deleted) error(404, { message: 'Concept not found' });
	return json({ ok: true });
};
