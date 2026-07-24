import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import { requireUser } from '$lib/server/auth/guards.js';
import { publishServerEvent } from '$lib/server/events/bus.js';
import { importSkillsFromGit } from '$lib/server/skills/gitImport.js';
import type { RequestHandler } from './$types';

const postSchema = z.object({
	gitUrl: z.string().min(1).max(500),
	branch: z.string().max(200).optional(),
	path: z.string().max(300).optional()
});

export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	const parsed = postSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, { message: parsed.error.issues[0]?.message ?? 'Invalid body' });
	try {
		const result = await importSkillsFromGit({ ...parsed.data, userId: user.id });
		if (result.imported.length > 0) publishServerEvent(user.id, { type: 'skills.changed' });
		return json(result, { status: 201 });
	} catch (e) {
		error(400, { message: e instanceof Error ? e.message : 'Git import failed' });
	}
};
