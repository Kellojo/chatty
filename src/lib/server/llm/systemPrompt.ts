import type { ConversationRow } from '../db/repo/conversations.js';
import { resolveSkill, skillsIndexPrompt } from '../skills/scanner.js';

const BASE_PROMPT = 'You are a helpful assistant. Answer concisely and use markdown formatting.';

export interface SystemPromptOptions {
	globalInstructions?: string;
	userId?: string;
	// Skill names bound to an agent/persona — their bodies are pre-loaded.
	boundSkillNames?: string[];
	// Set false to omit the available-skills index (e.g. when the skills MCP is disabled).
	includeSkillsIndex?: boolean;
	// Appended as a final warning note (e.g. a requested skill could not be loaded).
	extraWarning?: string | null;
}

export function buildSystemPrompt(
	conversation: ConversationRow,
	globalInstructionsOrOpts: string | SystemPromptOptions = ''
): string {
	const opts: SystemPromptOptions =
		typeof globalInstructionsOrOpts === 'string'
			? { globalInstructions: globalInstructionsOrOpts }
			: globalInstructionsOrOpts;
	const sections: string[] = [conversation.system_prompt ?? BASE_PROMPT];

	if (opts.userId && opts.boundSkillNames && opts.boundSkillNames.length > 0) {
		const loaded: string[] = [];
		for (const name of opts.boundSkillNames) {
			const skill = resolveSkill(opts.userId, name);
			if (skill && skill.enabled) loaded.push(`### Skill: ${skill.title}\n${skill.body}`);
		}
		if (loaded.length > 0) {
			sections.push(
				`## Bound skills\nThe following skills are pre-loaded for this conversation.\n\n${loaded.join('\n\n')}`
			);
		}
	}

	if (opts.userId && opts.includeSkillsIndex !== false) {
		const index = skillsIndexPrompt(opts.userId);
		if (index) sections.push(index);
	}

	const extra = opts.globalInstructions?.trim() ?? '';
	if (extra) sections.push(extra);
	if (opts.extraWarning) sections.push(`Note for this turn: ${opts.extraWarning}`);
	return sections.join('\n\n');
}
