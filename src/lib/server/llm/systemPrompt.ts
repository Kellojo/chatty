import type { ConversationRow } from '../db/repo/conversations.js';
import { resolveSkill, skillsIndexPrompt } from '../skills/scanner.js';
import { widgetsPrompt } from './widgets.js';

export const BASE_PROMPT =
	'You are a helpful assistant. Answer concisely and use markdown formatting.';

export interface SystemPromptOptions {
	globalInstructions?: string;
	userId?: string;
	// Skill names bound to an agent/persona — their bodies are pre-loaded.
	boundSkillNames?: string[];
	// Set false to omit the available-skills index (e.g. when the skills MCP is disabled).
	includeSkillsIndex?: boolean;
	// Appended as a final warning note (e.g. a requested skill could not be loaded).
	extraWarning?: string | null;
	// Every tool of the conversation (deferred ones too): decides which widgets are explained.
	toolNames?: Iterable<string>;
}

/**
 * The system prompt split into its contributors, so each piece's size can be
 * reported in the prompt breakdown. Empty strings mean "absent".
 */
export interface SystemPromptParts {
	/** Conversation prompt (or BASE_PROMPT). */
	base: string;
	/** The chat widgets the model can write. Kept with a custom prompt too: the chat still renders them. */
	widgets: string;
	/** Bound skills + the available-skills index. */
	skills: string;
	/** Global instructions + per-turn note. */
	system: string;
}

export function buildSystemPromptParts(
	conversation: ConversationRow,
	globalInstructionsOrOpts: string | SystemPromptOptions = ''
): SystemPromptParts {
	const opts: SystemPromptOptions =
		typeof globalInstructionsOrOpts === 'string'
			? { globalInstructions: globalInstructionsOrOpts }
			: globalInstructionsOrOpts;

	let skills = '';
	if (opts.userId && opts.boundSkillNames && opts.boundSkillNames.length > 0) {
		const loaded: string[] = [];
		for (const name of opts.boundSkillNames) {
			const skill = resolveSkill(opts.userId, name);
			if (skill && skill.enabled) loaded.push(`### Skill: ${skill.title}\n${skill.body}`);
		}
		if (loaded.length > 0) {
			skills += `## Bound skills\nThe following skills are pre-loaded for this conversation.\n\n${loaded.join('\n\n')}`;
		}
	}
	if (opts.userId && opts.includeSkillsIndex !== false) {
		const index = skillsIndexPrompt(opts.userId);
		if (index) skills += `${skills ? '\n\n' : ''}${index}`;
	}

	const extra = opts.globalInstructions?.trim() ?? '';
	const warning = opts.extraWarning ? `Note for this turn: ${opts.extraWarning}` : '';
	const system = [extra, warning].filter(Boolean).join('\n\n');

	return {
		base: conversation.system_prompt ?? BASE_PROMPT,
		widgets: widgetsPrompt(opts.toolNames),
		skills,
		system
	};
}

export function buildSystemPrompt(
	conversation: ConversationRow,
	globalInstructionsOrOpts: string | SystemPromptOptions = ''
): string {
	const parts = buildSystemPromptParts(conversation, globalInstructionsOrOpts);
	const sections = [parts.base, parts.widgets];
	if (parts.skills) sections.push(parts.skills);
	if (parts.system) sections.push(parts.system);
	return sections.join('\n\n');
}
