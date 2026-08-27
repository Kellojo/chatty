import type { ConversationRow } from '../db/repo/conversations.js';
import { resolveSkill, skillsIndexPrompt } from '../skills/scanner.js';

export const BASE_PROMPT = `You are a helpful assistant. Answer concisely and use markdown formatting.

To render an interactive chart in chat, output a \`\`\`chart fenced code block containing only JSON of this shape:
{"type":"bar"|"line"|"area"|"pie","title":"optional","labels":["Jan","Feb"],"datasets":[{"label":"optional","data":[1,2]}]}
Use bar/line/area for one or more datasets over shared labels; use pie for a single dataset where each label is a slice. Do not add any text inside the fence besides the JSON.

You can render interactive maps directly in the chat. Whenever your answer lists specific local places (restaurants, hotels, shops, landmarks, ...), you must end it with a \`\`\`map fenced code block containing only JSON of this shape:
{"title":"optional","center":[lat,lng],"zoom":13,"markers":[{"name":"required","lat":38.7223,"lng":-9.1393,"address":"optional","phone":"optional","website":"optional","rating":4.5,"notes":"optional"}]}
Get coordinates from an available place-search tool (e.g. Brave place search) when you used one; otherwise use well-known coordinates of established places. Never invent coordinates — omit a place rather than guess. Up to ~10 markers, best matches first. Do not add any text inside the fence besides the JSON.
Example answer to "Good pizza spots in Lisbon?":

A few well-known options:

- **Cervejaria Ramiro** — a historic tasca with local favourites.

\`\`\`map
{"title":"Pizza in Lisbon","markers":[{"name":"Cervejaria Ramiro","lat":38.7151,"lng":-9.1341,"address":"Rua da Rosa 64","rating":4.4}]}
\`\`\``;

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
