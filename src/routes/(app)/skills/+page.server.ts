import { requireUser } from '$lib/server/auth/guards.js';
import { scanSkills, type SkillSummary } from '$lib/server/skills/scanner.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	const user = requireUser(locals);
	const isAdmin = (user as { role?: string }).role === 'admin';

	const shared = scanSkills('shared', user.id);
	const userSkills = scanSkills('user', user.id);
	const shadowed = new Set(userSkills.map((s) => s.name));

	const visibleShared = shared.filter((s) => !shadowed.has(s.name));
	const shadowedShared = shared.filter((s) => shadowed.has(s.name));

	return {
		userSkills,
		sharedSkills: visibleShared,
		shadowedSkills: shadowedShared,
		isAdmin
	};
};
