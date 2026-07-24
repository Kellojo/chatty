import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import { requireUser } from '$lib/server/auth/guards.js';
import { publishServerEvent } from '$lib/server/events/bus.js';
import { listAllSkills } from '$lib/server/skills/scanner.js';
import { writeSkill } from '$lib/server/skills/store.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals }) => {
	const user = requireUser(locals);
	return json({ skills: listAllSkills(user.id) });
};

const postSchema = z.object({
	name: z.string().min(1).max(64),
	title: z.string().min(1).max(120),
	description: z.string().min(1).max(500),
	body: z.string().default('')
});

export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	const parsed = postSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, { message: parsed.error.issues[0]?.message ?? 'Invalid body' });
	try {
		const skill = writeSkill('user', user.id, {
			...parsed.data,
			body: parsed.data.body || `Instructions for the ${parsed.data.title} skill.\n`
		});
		publishServerEvent(user.id, { type: 'skills.changed' });
		return json({ skill }, { status: 201 });
	} catch (e) {
		error(400, { message: e instanceof Error ? e.message : 'Failed to create skill' });
	}
};
