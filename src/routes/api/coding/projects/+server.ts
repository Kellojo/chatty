import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import { requireUser } from '$lib/server/auth/guards.js';
import { codingRoute } from '$lib/server/t3/http.js';
import { createCodingProject } from '$lib/server/t3/tasks.js';
import type { RequestHandler } from './$types';

const createSchema = z.object({
	environmentId: z.string().trim().min(1).max(256),
	title: z.string().trim().min(1, 'Enter a project name').max(200),
	repository: z.string().trim().min(1).max(2048).optional()
});

/** Creates a new empty project, or clones `repository`, on a coding environment. */
export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	const parsed = createSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, { message: parsed.error.issues[0]?.message ?? 'Invalid body' });
	const result = await codingRoute(() => createCodingProject(user.id, parsed.data));
	return json(result, { status: 201 });
};
