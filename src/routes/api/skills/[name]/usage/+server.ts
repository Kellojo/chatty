import { error, json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { getSkillUsage } from '$lib/server/db/repo/skill-invocations.js';
import { readSkill } from '$lib/server/skills/scanner.js';
import type { RequestHandler } from './$types';

/** Per-trigger and per-day uses of one skill: everyone's for an admin on a shared skill, else the caller's. */
export const GET: RequestHandler = async ({ locals, params, url }) => {
	const user = requireUser(locals);
	const scope = url.searchParams.get('scope') === 'shared' ? 'shared' : 'user';
	const skill = await readSkill(scope, user.id, params.name);
	if (!skill) error(404, { message: 'Skill not found' });
	const isAdmin = (user as { role?: string }).role === 'admin';
	return json(getSkillUsage(getDb(), { userId: user.id, isAdmin }, { scope, name: skill.name }));
};
