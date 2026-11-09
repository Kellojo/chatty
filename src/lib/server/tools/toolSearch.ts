import {
	NoSuchToolError,
	tool,
	type Tool,
	type ToolCallRepairFunction,
	type ToolSet,
	type UIMessage
} from 'ai';
import { z } from 'zod';
import { estimateToolChars } from '../llm/promptBreakdown.js';

/**
 * On-demand tool loading. Tools of servers set to load "deferred" are left out
 * of the prompt; the model sees their names in the system prompt and loads the
 * ones it needs through `search_tools`.
 *
 * - Anthropic models with tool search get every tool with `deferLoading`, and
 *   `search_tools` answers with `tool_reference` blocks. Loading a tool then
 *   leaves the cached prompt prefix intact.
 * - Every other model gets the core tools plus whatever was loaded so far
 *   (`activeTools`); a loaded tool joins the list from the next step on. Tools
 *   loaded in earlier turns are read back from the history, so the list only
 *   ever grows within a conversation and the prompt prefix stays stable.
 */

export const SEARCH_TOOLS_NAME = 'search_tools';

/** Below this many characters of deferred tool definitions, searching costs more than it saves. */
export const DEFER_MIN_CHARS = 4000;

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
const MAX_NAMES_PER_SERVER = 40;
const MAX_DESCRIPTION_CHARS = 240;

export interface ToolCatalog {
	tools: Record<string, Tool>;
	toolToServer: Record<string, string>;
	/** Names of the tools that are not sent until loaded. Empty: tool search is off. */
	deferred: Set<string>;
}

export interface LoadedTool {
	name: string;
	server: string;
	description: string;
}

export interface SearchToolsOutput {
	loaded: LoadedTool[];
	note?: string;
}

/** Tools that prompts tell the model to call directly (the skills index), so they are never deferred. */
const NEVER_DEFERRED = new Set(['load_skill', 'read_skill_reference']);

/**
 * Rarely used tools of builtin servers that are otherwise always loaded: they
 * answer explicit requests ("create a skill", "forget …"), where one search
 * step costs little. Keyed by server name; builtin names are unique.
 */
const ON_DEMAND_BUILTIN_TOOLS: Record<string, readonly string[]> = {
	skills: ['create_skill', 'update_skill', 'delete_skill'],
	fs: ['fs_curl', 'fs_mkdir', 'fs_rm'],
	memory: ['delete_concept']
};

/**
 * Picks the tools to defer: those of deferred servers and the rarely used
 * builtin tools, unless they are so few that one search round trip costs more
 * than sending them.
 */
export function pickDeferredTools(
	tools: Record<string, Tool>,
	toolToServer: Record<string, string>,
	deferredServers: Set<string>
): Set<string> {
	const names = Object.keys(tools).filter((name) => {
		if (NEVER_DEFERRED.has(name)) return false;
		const server = toolToServer[name];
		return deferredServers.has(server) || ON_DEMAND_BUILTIN_TOOLS[server]?.includes(name);
	});
	const subset = Object.fromEntries(names.map((name) => [name, tools[name]]));
	if (estimateToolChars(subset) < DEFER_MIN_CHARS) return new Set();
	return new Set(names);
}

function descriptionOf(t: Tool | undefined): string {
	return typeof t?.description === 'string' ? t.description : '';
}

function words(text: string): string[] {
	return text
		.replace(/([a-z])([A-Z])/g, '$1 $2')
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((w) => w.length >= 2);
}

function stem(word: string): string {
	return word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word;
}

/**
 * Ranks deferred tools against a keyword query. Exact tool names always match,
 * so the model can load a tool it saw in the system prompt by naming it.
 */
export function searchToolCatalog(
	catalog: ToolCatalog,
	query: string,
	limit = DEFAULT_LIMIT
): LoadedTool[] {
	const raw = query.toLowerCase();
	const terms = [...new Set(words(query).map(stem))];
	const scored: Array<{ name: string; score: number }> = [];
	for (const name of catalog.deferred) {
		const lower = name.toLowerCase();
		const server = (catalog.toolToServer[name] ?? '').toLowerCase();
		const nameWords = words(name).map(stem);
		const serverWords = words(server).map(stem);
		const descWords = words(descriptionOf(catalog.tools[name])).map(stem);
		let score = new RegExp(
			`(^|[^a-z0-9_])${lower.replace(/[^a-z0-9_]/g, '\\$&')}($|[^a-z0-9_])`
		).test(raw)
			? 100
			: 0;
		for (const term of terms) {
			if (nameWords.includes(term)) score += 4;
			else if (lower.includes(term)) score += 3;
			if (serverWords.includes(term) || server === term) score += 2;
			if (descWords.some((w) => w === term || (term.length >= 4 && w.startsWith(term)))) score += 1;
		}
		if (score > 0) scored.push({ name, score });
	}
	scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
	return scored.slice(0, limit).map(({ name }) => {
		const description = descriptionOf(catalog.tools[name]);
		return {
			name,
			server: catalog.toolToServer[name] ?? '',
			description:
				description.length > MAX_DESCRIPTION_CHARS
					? `${description.slice(0, MAX_DESCRIPTION_CHARS - 1)}…`
					: description
		};
	});
}

/** System prompt section naming the deferred tools, so the model knows what it can load. */
export function deferredToolsPrompt(catalog: ToolCatalog): string {
	if (catalog.deferred.size === 0) return '';
	const byServer = new Map<string, string[]>();
	for (const name of catalog.deferred) {
		const server = catalog.toolToServer[name] ?? 'other';
		byServer.set(server, [...(byServer.get(server) ?? []), name]);
	}
	const lines = [...byServer.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([server, names]) => {
			const shown = names.slice(0, MAX_NAMES_PER_SERVER).join(', ');
			const more =
				names.length > MAX_NAMES_PER_SERVER
					? `, … (+${names.length - MAX_NAMES_PER_SERVER} more)`
					: '';
			return `- ${server}: ${shown}${more}`;
		});
	return [
		'## Tools loaded on demand',
		`More tools are available but not loaded yet. To use one, first call \`${SEARCH_TOOLS_NAME}\` with keywords or the exact tool names; the tools it returns can be called from then on. Load a tool before saying you cannot do something.`,
		...lines
	].join('\n');
}

function outputNames(output: unknown): string[] {
	const loaded = (output as Partial<SearchToolsOutput> | null)?.loaded;
	if (!Array.isArray(loaded)) return [];
	return loaded
		.map((t) => (t as Partial<LoadedTool> | null)?.name)
		.filter((n): n is string => typeof n === 'string');
}

/** Deferred tools the conversation already loaded (via search_tools) or called in earlier turns. */
export function loadedToolsFromHistory(messages: UIMessage[], deferred: Set<string>): Set<string> {
	const loaded = new Set<string>();
	if (deferred.size === 0) return loaded;
	for (const message of messages) {
		if (message.role !== 'assistant') continue;
		for (const part of message.parts) {
			const p = part as { type: string; toolName?: string; state?: string; output?: unknown };
			const name =
				p.type === 'dynamic-tool'
					? p.toolName
					: p.type.startsWith('tool-')
						? p.type.slice(5)
						: null;
			if (!name) continue;
			if (name === SEARCH_TOOLS_NAME) {
				if (p.state === 'output-available') for (const n of outputNames(p.output)) loaded.add(n);
			} else {
				loaded.add(name);
			}
		}
	}
	return new Set([...loaded].filter((name) => deferred.has(name)));
}

/** Anthropic models that support tool search (`deferLoading` + `tool_reference`). */
export function supportsNativeToolSearch(
	providerType: string | undefined,
	modelId: string
): boolean {
	if (providerType !== 'anthropic') return false;
	const id = modelId.toLowerCase();
	// Sonnet/Opus 4.5 and later, and every family from 5 on.
	return /(?:opus|sonnet)-4-(?:[5-9]|\d{2})(?!\d)|(?:opus|sonnet|haiku|fable)-(?:[5-9]|\d{2})(?![\d])/.test(
		id
	);
}

export interface ToolSearchSetup {
	/** Every tool to pass to the model call. */
	tools: Record<string, Tool>;
	/** For `prepareStep`: the tools the model may see on the next step, or undefined for all. */
	activeTools: () => string[] | undefined;
	/** The tools whose definitions are in the prompt right now (for the prompt breakdown). */
	promptTools: () => Record<string, Tool>;
	/** Pass to `convertToModelMessages` so earlier search results replay the same way. */
	historyTools: Record<string, Tool>;
	/**
	 * For `experimental_repairToolCall`: a call to a deferred tool that is not
	 * loaded yet becomes a search for it, which loads it for the next step.
	 */
	repairToolCall: ToolCallRepairFunction<ToolSet> | undefined;
}

/**
 * Prepares one model call's tools. `native` selects Anthropic's tool search;
 * `loaded` are deferred tools the conversation already loaded.
 */
export function withToolSearch(
	catalog: ToolCatalog,
	opts: { native: boolean; loaded: Set<string> }
): ToolSearchSetup {
	const { tools, deferred } = catalog;
	if (deferred.size === 0) {
		return {
			tools,
			activeTools: () => undefined,
			promptTools: () => tools,
			historyTools: {},
			repairToolCall: undefined
		};
	}
	const loaded = new Set(opts.loaded);
	const core = Object.keys(tools).filter((name) => !deferred.has(name));

	const search = tool({
		description:
			'Load tools that are not loaded yet. Search by keywords describing the task (e.g. "weather forecast", "unit conversion") or by exact tool names (comma-separated). The matching tools can be called right after.',
		inputSchema: z.object({
			query: z.string().min(1).max(500),
			limit: z.number().int().min(1).max(MAX_LIMIT).optional()
		}),
		execute: async ({ query, limit }): Promise<SearchToolsOutput> => {
			const found = searchToolCatalog(catalog, query, limit ?? DEFAULT_LIMIT);
			for (const t of found) loaded.add(t.name);
			if (found.length === 0) {
				return { loaded: [], note: 'No matching tools. Try other keywords or an exact tool name.' };
			}
			const exact = found.find((t) => t.name === query.trim());
			if (exact) {
				return { loaded: found, note: `${exact.name} is loaded now. Call it directly.` };
			}
			return { loaded: found };
		},
		...(opts.native
			? {
					toModelOutput: ({ output }: { output: SearchToolsOutput }) => {
						const names = outputNames(output).filter((name) => deferred.has(name));
						if (names.length === 0) {
							return {
								type: 'text' as const,
								value:
									output?.note ?? 'No matching tools. Try other keywords or an exact tool name.'
							};
						}
						return {
							type: 'content' as const,
							value: names.map((toolName) => ({
								type: 'custom' as const,
								providerOptions: { anthropic: { type: 'tool-reference', toolName } }
							}))
						};
					}
				}
			: {})
	}) as Tool;

	const sent: Record<string, Tool> = {};
	for (const name of core) sent[name] = tools[name];
	sent[SEARCH_TOOLS_NAME] = search;
	for (const name of deferred) {
		const t = tools[name];
		sent[name] = opts.native
			? {
					...t,
					providerOptions: {
						...t.providerOptions,
						anthropic: { ...t.providerOptions?.anthropic, deferLoading: true }
					}
				}
			: t;
	}

	const visible = () => [...core, SEARCH_TOOLS_NAME, ...[...deferred].filter((n) => loaded.has(n))];
	return {
		tools: sent,
		activeTools: opts.native ? () => undefined : visible,
		promptTools: () => {
			const names = opts.native ? [...core, SEARCH_TOOLS_NAME] : visible();
			return Object.fromEntries(names.map((name) => [name, sent[name]]));
		},
		historyTools: { [SEARCH_TOOLS_NAME]: search },
		// Anthropic only lets the model call tools it loaded, so only the
		// activeTools path can see calls to tools that are not loaded yet.
		repairToolCall: opts.native
			? undefined
			: async ({ toolCall, error }) => {
					if (!NoSuchToolError.isInstance(error) || !deferred.has(toolCall.toolName)) return null;
					return {
						...toolCall,
						toolName: SEARCH_TOOLS_NAME,
						input: JSON.stringify({ query: toolCall.toolName })
					};
				}
	};
}
