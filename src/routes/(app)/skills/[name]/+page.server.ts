import { error } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import { listSkillInvocations } from '$lib/server/db/repo/skill-invocations.js';
import { getTimeFormat } from '$lib/server/db/repo/user-settings.js';
import { readSkill } from '$lib/server/skills/scanner.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, params, url }) => {
	const user = requireUser(locals);
	const scope = url.searchParams.get('scope') === 'shared' ? 'shared' : 'user';
	if (scope === 'shared' && (user as { role?: string }).role !== 'admin') {
		error(403, { message: 'Admin required' });
	}
	const skill = readSkill(scope, user.id, params.name);
	if (!skill) error(404, { message: 'Skill not found' });
	return {
		skill,
		scope,
		invocations: listSkillInvocations(getDb(), {
			userId: user.id,
			skillName: skill.name,
			limit: 50
		}),
		timeFormat: getTimeFormat(getDb(), user.id),
		isAdmin: (user as { role?: string }).role === 'admin'
	};
};
