export type SkillScope = 'user' | 'shared';

export interface SkillSummary {
	name: string;
	scope: SkillScope;
	title: string;
	description: string;
	enabled: boolean;
	source: string;
	version: string | null;
	author: string | null;
	references: string[];
}

export interface SkillFrontmatter {
	name: string;
	title: string;
	description: string;
	triggers: Array<{ keyword?: string; intent?: string }>;
	when: string | null;
	tools: string[];
	enabled: boolean;
	source: string;
	version: string | null;
	author: string | null;
}

export interface Skill extends SkillSummary {
	frontmatter: SkillFrontmatter;
	body: string;
}

export interface SkillInvocation {
	id: string;
	skill_name: string;
	scope: string;
	user_id: string;
	conversation_id: string | null;
	message_id: string | null;
	triggered_by: string;
	created_at: number;
}

/** How a skill got loaded: picked in the composer, loaded by the model in a chat, or by an agent run. */
export type SkillTrigger = 'manual' | 'auto' | 'agent';
export const SKILL_TRIGGERS: readonly SkillTrigger[] = ['manual', 'auto', 'agent'];

/** Usage maps are keyed by scope and name: a user skill can share its name with a shared one. */
export function skillUsageKey(skill: { scope: string; name: string }): string {
	return `${skill.scope}:${skill.name}`;
}

/** A skill's uses over the window, as the viewer may see them. */
export interface SkillUsage {
	uses: number;
	/** Distinct users who loaded it. */
	users: number;
	/** Latest use ever, even before the window. */
	lastUsedAt: number | null;
}

/** One skill's uses over the window. */
export interface SkillUsageDetail {
	days: number;
	users: number;
	uses: Record<SkillTrigger, number>;
	/** One entry per UTC day of the window, oldest first. */
	daily: ({ day: string } & Record<SkillTrigger, number>)[];
}

/** Every skill's uses over `days` (Skills → Statistics). */
export interface SkillUsageStats {
	days: number;
	/** Distinct users who loaded any skill. */
	users: number;
	/** Skills with at least one use, most used first (may include deleted skills). */
	skills: ({
		key: string;
		scope: SkillScope;
		name: string;
		uses: number;
		users: number;
		lastUsedAt: number;
	} & Record<SkillTrigger, number>)[];
	/** One entry per UTC day, oldest first; uses keyed by skill usage key (absent: none). */
	daily: { day: string; uses: Record<string, number> }[];
}
