import { error } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { listSkillInvocations } from '$lib/server/db/repo/skill-invocations.js';
import { getTimeFormat } from '$lib/server/db/repo/user-settings.js';
import { readSkill } from '$lib/server/skills/scanner.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, params, url }) => {
	const user = requireUser(locals);
	const isAdmin = (user as { role?: string }).role === 'admin';
	const scope = url.searchParams.get('scope') === 'shared' ? 'shared' : 'user';
	const skill = readSkill(scope, user.id, params.name);
	if (!skill) error(404, { message: 'Skill not found' });
	const canEdit = scope === 'user' || isAdmin;
	return {
		skill,
		scope,
		canEdit,
		invocations: listSkillInvocations(getDb(), {
			userId: user.id,
			skillName: skill.name,
			limit: 50
		}),
		timeFormat: getTimeFormat(getDb(), user.id),
		isAdmin
	};
};
