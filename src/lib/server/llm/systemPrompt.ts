import { DateTime } from 'luxon';
import { config } from '../config.js';
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
	// Set false where nobody renders widgets (hidden agent runs).
	includeWidgets?: boolean;
	// States this day's date, so "next weekend" or "upcoming" needs no clock tool call.
	// Only the date: it changes once a day, which keeps the prompt cacheable.
	today?: Date;
}

/** "Today is Saturday, 21 November 2026 (Europe/Berlin)." in the server's zone. */
export function todayLine(now: Date, zone: string = config.TZ): string {
	const dt = DateTime.fromJSDate(now, { zone });
	const day = (dt.isValid ? dt : DateTime.fromJSDate(now, { zone: 'utc' })).setLocale('en-GB');
	return `Today is ${day.toFormat('cccc, d LLLL yyyy')} (${day.zoneName}).`;
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

export async function buildSystemPromptParts(
	conversation: ConversationRow,
	globalInstructionsOrOpts: string | SystemPromptOptions = ''
): Promise<SystemPromptParts> {
	const opts: SystemPromptOptions =
		typeof globalInstructionsOrOpts === 'string'
			? { globalInstructions: globalInstructionsOrOpts }
			: globalInstructionsOrOpts;

	let skills = '';
	if (opts.userId && opts.boundSkillNames && opts.boundSkillNames.length > 0) {
		const loaded: string[] = [];
		for (const name of opts.boundSkillNames) {
			const skill = await resolveSkill(opts.userId, name);
			if (skill && skill.enabled) loaded.push(`### Skill: ${skill.title}\n${skill.body}`);
		}
		if (loaded.length > 0) {
			skills += `## Bound skills\nThe following skills are pre-loaded for this conversation.\n\n${loaded.join('\n\n')}`;
		}
	}
	if (opts.userId && opts.includeSkillsIndex !== false) {
		const index = await skillsIndexPrompt(opts.userId);
		if (index) skills += `${skills ? '\n\n' : ''}${index}`;
	}

	const extra = opts.globalInstructions?.trim() ?? '';
	const warning = opts.extraWarning ? `Note for this turn: ${opts.extraWarning}` : '';
	const date = opts.today ? todayLine(opts.today) : '';
	const system = [date, extra, warning].filter(Boolean).join('\n\n');

	return {
		base: conversation.system_prompt ?? BASE_PROMPT,
		widgets: opts.includeWidgets === false ? '' : widgetsPrompt(opts.toolNames),
		skills,
		system
	};
}

export async function buildSystemPrompt(
	conversation: ConversationRow,
	globalInstructionsOrOpts: string | SystemPromptOptions = ''
): Promise<string> {
	const parts = await buildSystemPromptParts(conversation, globalInstructionsOrOpts);
	const sections = [parts.base, parts.widgets];
	if (parts.skills) sections.push(parts.skills);
	if (parts.system) sections.push(parts.system);
	return sections.join('\n\n');
}
