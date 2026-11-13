import { requireUser } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import {
	getSkillUsageStats,
	SKILL_USAGE_WINDOW_DAYS,
	summarizeSkillUsage
} from '$lib/server/db/repo/skill-invocations.js';
import { scanSkills } from '$lib/server/skills/scanner.js';
import { parseUsagePeriod, periodDays } from '$lib/components/app/usage/usage.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	const user = requireUser(locals);
	const isAdmin = (user as { role?: string }).role === 'admin';

	const [shared, userSkills] = await Promise.all([
		scanSkills('shared', user.id),
		scanSkills('user', user.id)
	]);
	const shadowed = new Set(userSkills.map((s) => s.name));

	const visibleShared = shared.filter((s) => !shadowed.has(s.name));
	const shadowedShared = shared.filter((s) => shadowed.has(s.name));

	const db = getDb();
	const viewer = { userId: user.id, isAdmin };
	const period = parseUsagePeriod(url.searchParams.get('period'));
	return {
		userSkills,
		sharedSkills: visibleShared,
		shadowedSkills: shadowedShared,
		isAdmin,
		usage: summarizeSkillUsage(db, viewer),
		usageWindowDays: SKILL_USAGE_WINDOW_DAYS,
		/** The Statistics tab, over the `?period=` it shows. */
		stats: { period, ...getSkillUsageStats(db, viewer, periodDays(period)) }
	};
};
