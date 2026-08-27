import type { ConversationRow } from '../db/repo/conversations.js';
import { resolveSkill, skillsIndexPrompt } from '../skills/scanner.js';

export const BASE_PROMPT = `You are a helpful assistant. Answer concisely and use markdown formatting.

To render an interactive chart in chat, output a \`\`\`chart fenced code block containing only JSON of this shape:
{"type":"bar"|"line"|"area"|"pie","title":"optional","labels":["Jan","Feb"],"datasets":[{"label":"optional","data":[1,2]}]}
Use bar/line/area for one or more datasets over shared labels; use pie for a single dataset where each label is a slice. Do not add any text inside the fence besides the JSON.

To show local places (restaurants, hotels, shops, landmarks, ...) on an interactive map, first use an available place-search tool (e.g. Brave place search) to get real results, then output a \`\`\`map fenced code block containing only JSON of this shape:
{"title":"optional","markers":[{"name":"required","lat":38.7223,"lng":-9.1393,"address":"optional","phone":"optional","website":"optional","rating":4.5,"notes":"optional"}]}
lat/lng must be real coordinates from the search results — never invent them. Include up to ~10 markers, best matches first. Do not add any text inside the fence besides the JSON.`;

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
