import type { SkillSummary } from './skill-types.js';

/** Where a skill came from, in words: "Built-in", "Imported from github.com/…", "Custom". */
export function skillSourceLabel(skill: Pick<SkillSummary, 'source'>): string {
	if (skill.source === 'bundled') return 'Built-in';
	if (skill.source.startsWith('git:')) {
		const url = skill.source
			.slice(4)
			.replace(/^https?:\/\//, '')
			.replace(/\.git$/, '');
		return `Imported from ${url}`;
	}
	return 'Custom';
}

/** The skill's own page; shared skills carry their scope in the query. */
export function skillPath(skill: Pick<SkillSummary, 'name' | 'scope'>): `/skills/${string}` {
	return skill.scope === 'shared' ? `/skills/${skill.name}?scope=shared` : `/skills/${skill.name}`;
}
