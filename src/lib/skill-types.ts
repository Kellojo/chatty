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
