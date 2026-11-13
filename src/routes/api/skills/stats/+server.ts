import { json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { listAllSkills } from '$lib/server/skills/scanner.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals }) => {
	const user = requireUser(locals);
	const skills = await listAllSkills(user.id);
	return json({ count: skills.length, enabled: skills.filter((s) => s.enabled).length });
};
