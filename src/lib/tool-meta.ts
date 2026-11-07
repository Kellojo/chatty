/**
 * How tool calls are presented in the chat timeline: a readable label, a
 * one-line detail (the command, path, query…) and a kind that picks the icon.
 * Shared by builtin MCP tools and coding-agent (T3) items.
 */

export type ToolKind =
	| 'command'
	| 'code'
	| 'edit'
	| 'read'
	| 'search'
	| 'web'
	| 'agent'
	| 'subagent'
	| 'memory'
	| 'skill'
	| 'image'
	| 'math'
	| 'time'
	| 'settings'
	| 'weather'
	| 'wait'
	| 'chat'
	| 'checkpoint'
	| 'todo'
	| 'question'
	| 'approval'
	| 'error'
	| 'tool';

export interface ToolMeta {
	label: string;
	server: string;
	kind: ToolKind;
	/** Input field shown as the one-line detail. */
	detail?: string;
}

const MATH_TOOLS = [
	['add', 'Add'],
	['subtract', 'Subtract'],
	['multiply', 'Multiply'],
	['divide', 'Divide'],
	['power', 'Power'],
	['sqrt', 'Square root'],
	['abs', 'Absolute value'],
	['round', 'Round'],
	['floor', 'Round down'],
	['ceil', 'Round up'],
	['modulo', 'Modulo'],
	['log', 'Logarithm'],
	['exp', 'Exponential'],
	['factorial', 'Factorial'],
	['gcd', 'Greatest common divisor'],
	['lcm', 'Least common multiple'],
	['min', 'Minimum'],
	['max', 'Maximum'],
	['sum', 'Sum'],
	['mean', 'Mean'],
	['median', 'Median'],
	['stdev', 'Standard deviation'],
	['percentage', 'Percentage'],
	['convert_units', 'Convert units'],
	['convert_many', 'Convert several units'],
	['list_units', 'List units']
] as const;

export const TOOL_META: Record<string, ToolMeta> = {
	fetch: { label: 'Fetch URL', server: 'webfetch', kind: 'web', detail: 'url' },
	now: { label: 'Current time', server: 'datetime', kind: 'time' },
	get_timezone: { label: 'Get timezone', server: 'datetime', kind: 'time' },
	format: { label: 'Format date', server: 'datetime', kind: 'time', detail: 'iso' },
	convert: { label: 'Convert timezone', server: 'datetime', kind: 'time', detail: 'to' },
	search_chats: { label: 'Search chats', server: 'chat-search', kind: 'chat', detail: 'query' },
	read_chat: { label: 'Read chat', server: 'chat-search', kind: 'chat' },
	fs_ls: { label: 'List files', server: 'fs', kind: 'read', detail: 'path' },
	fs_read: { label: 'Read file', server: 'fs', kind: 'read', detail: 'path' },
	fs_head: { label: 'Read file start', server: 'fs', kind: 'read', detail: 'path' },
	fs_tail: { label: 'Read file end', server: 'fs', kind: 'read', detail: 'path' },
	fs_wc: { label: 'Count words', server: 'fs', kind: 'read', detail: 'path' },
	fs_grep: { label: 'Search in files', server: 'fs', kind: 'search', detail: 'pattern' },
	fs_glob: { label: 'Find files', server: 'fs', kind: 'search', detail: 'pattern' },
	fs_write: { label: 'Write file', server: 'fs', kind: 'edit', detail: 'path' },
	fs_edit: { label: 'Edit file', server: 'fs', kind: 'edit', detail: 'path' },
	fs_mkdir: { label: 'Create directory', server: 'fs', kind: 'edit', detail: 'path' },
	fs_rm: { label: 'Delete file', server: 'fs', kind: 'edit', detail: 'path' },
	fs_curl: { label: 'Download file', server: 'fs', kind: 'web', detail: 'url' },
	get_setting: { label: 'Get setting', server: 'settings', kind: 'settings', detail: 'key' },
	list_settings: { label: 'List settings', server: 'settings', kind: 'settings' },
	update_setting: { label: 'Update setting', server: 'settings', kind: 'settings', detail: 'key' },
	search_memory: { label: 'Search memory', server: 'memory', kind: 'memory', detail: 'query' },
	read_concept: { label: 'Read memory', server: 'memory', kind: 'memory', detail: 'path' },
	list_concepts: { label: 'List memories', server: 'memory', kind: 'memory' },
	create_concept: { label: 'Save memory', server: 'memory', kind: 'memory', detail: 'path' },
	update_concept: { label: 'Update memory', server: 'memory', kind: 'memory', detail: 'path' },
	delete_concept: { label: 'Delete memory', server: 'memory', kind: 'memory', detail: 'path' },
	list_agents: { label: 'List agents', server: 'agents', kind: 'agent' },
	get_agent: { label: 'Get agent', server: 'agents', kind: 'agent', detail: 'agentId' },
	create_agent: { label: 'Create agent', server: 'agents', kind: 'agent', detail: 'name' },
	update_agent: { label: 'Update agent', server: 'agents', kind: 'agent', detail: 'agentId' },
	delete_agent: { label: 'Delete agent', server: 'agents', kind: 'agent', detail: 'agentId' },
	load_skill: { label: 'Load skill', server: 'skills', kind: 'skill', detail: 'name' },
	read_skill_reference: {
		label: 'Read skill reference',
		server: 'skills',
		kind: 'skill',
		detail: 'path'
	},
	create_skill: { label: 'Create skill', server: 'skills', kind: 'skill', detail: 'name' },
	update_skill: { label: 'Update skill', server: 'skills', kind: 'skill', detail: 'name' },
	delete_skill: { label: 'Delete skill', server: 'skills', kind: 'skill', detail: 'name' },
	code_exec: { label: 'Run code', server: 'code-exec', kind: 'code', detail: 'code' },
	generate_image: { label: 'Generate image', server: 'image', kind: 'image', detail: 'prompt' },
	edit_image: { label: 'Edit image', server: 'image', kind: 'image', detail: 'prompt' },
	wait: { label: 'Wait', server: 'wait', kind: 'wait', detail: 'seconds' },
	get_weather: { label: 'Get weather', server: 'weather', kind: 'weather', detail: 'location' },
	...Object.fromEntries(
		MATH_TOOLS.map(([name, label]) => [name, { label, server: 'math', kind: 'math' as const }])
	),

	// Coding-agent items, see src/lib/server/t3/projection.ts.
	run_command: { label: 'Ran command', server: 'coding', kind: 'command', detail: 'command' },
	edit_files: { label: 'Edited', server: 'coding', kind: 'edit' },
	web_search: { label: 'Searched the web', server: 'coding', kind: 'web', detail: 'query' },
	file_search: { label: 'Searched files', server: 'coding', kind: 'search', detail: 'pattern' },
	todo_list: { label: 'Updated plan', server: 'coding', kind: 'todo' },
	approval: { label: 'Approval', server: 'coding', kind: 'approval', detail: 'request' },
	question: { label: 'Asked a question', server: 'coding', kind: 'question' },
	checkpoint: { label: 'Checkpoint', server: 'coding', kind: 'checkpoint' },
	dynamic_tool: { label: 'Used a tool', server: 'coding', kind: 'tool' },
	error: { label: 'Error', server: 'coding', kind: 'error' },
	subagent: { label: 'Subagent', server: 'coding', kind: 'subagent', detail: 'description' },

	// The coding agent's own tools, reported by name (Claude Code naming).
	Read: { label: 'Read', server: 'coding', kind: 'read', detail: 'file_path' },
	Write: { label: 'Wrote', server: 'coding', kind: 'edit', detail: 'file_path' },
	Edit: { label: 'Edited', server: 'coding', kind: 'edit', detail: 'file_path' },
	MultiEdit: { label: 'Edited', server: 'coding', kind: 'edit', detail: 'file_path' },
	NotebookEdit: {
		label: 'Edited notebook',
		server: 'coding',
		kind: 'edit',
		detail: 'notebook_path'
	},
	Glob: { label: 'Found files', server: 'coding', kind: 'search', detail: 'pattern' },
	Grep: { label: 'Searched', server: 'coding', kind: 'search', detail: 'pattern' },
	Bash: { label: 'Ran command', server: 'coding', kind: 'command', detail: 'command' },
	PowerShell: { label: 'Ran command', server: 'coding', kind: 'command', detail: 'command' },
	WebFetch: { label: 'Fetched', server: 'coding', kind: 'web', detail: 'url' },
	WebSearch: { label: 'Searched the web', server: 'coding', kind: 'web', detail: 'query' },
	TodoWrite: { label: 'Updated plan', server: 'coding', kind: 'todo' },
	Agent: { label: 'Subagent', server: 'coding', kind: 'subagent', detail: 'description' },
	Task: { label: 'Subagent', server: 'coding', kind: 'subagent', detail: 'description' },
	Skill: { label: 'Used skill', server: 'coding', kind: 'skill', detail: 'skill' },
	ToolSearch: { label: 'Loaded tools', server: 'coding', kind: 'tool', detail: 'query' },
	AskUserQuestion: { label: 'Asked a question', server: 'coding', kind: 'question' },
	ExitPlanMode: { label: 'Proposed a plan', server: 'coding', kind: 'todo' }
};

export interface ToolDisplay {
	label: string;
	detail: string | null;
	kind: ToolKind;
	/** Builtin server name, null for unknown (user-added or coding-agent) tools. */
	server: string | null;
	/** The detail is a sentence (a title, a prompt), not code, a path or arguments. */
	prose: boolean;
}

/**
 * Coding agents sometimes report a step title ("Preparing workspace") where a
 * command would go: a capitalised phrase of plain words, no shell syntax.
 */
function isTitle(text: string | null): boolean {
	return text !== null && /^[A-Z][a-z]+(?: [a-z]+){0,5}$/.test(text);
}

/** Coding-agent kinds whose detail is written for people rather than a machine. */
const PROSE_KINDS = new Set<ToolKind>(['approval', 'question', 'todo', 'subagent']);

/** Input fields holding a file path, shortened to their last segments. */
const PATH_FIELDS = new Set(['path', 'file_path', 'notebook_path']);

/** "mcp__t3-code__preview_open" → server "t3-code", tool "preview_open". */
const MCP_NAME = /^mcp__(.+?)__(.+)$/;

function oneLine(value: unknown): string | null {
	if (value == null) return null;
	const text = typeof value === 'string' ? value : JSON.stringify(value);
	const line = text.replace(/\s+/g, ' ').trim();
	return line ? line : null;
}

function argValue(value: unknown): string {
	if (typeof value === 'string') return value;
	if (Array.isArray(value) && value.every((v) => v === null || typeof v !== 'object')) {
		return value.join(', ');
	}
	return JSON.stringify(value);
}

/** "a: 2 · b: 3" for small argument objects; null when it wouldn't fit on a line. */
function compactArgs(args: Record<string, unknown>): string | null {
	const entries = Object.entries(args).filter(([key]) => key !== 'kind');
	if (entries.length === 0) return null;
	const text = entries.map(([key, value]) => `${key}: ${argValue(value)}`).join(' · ');
	return text.length <= 80 ? text : null;
}

/** "list_recipes" → "List recipes" for tools from user-added MCP servers. */
function humanize(name: string): string {
	const words = name.replace(/[_-]+/g, ' ').trim();
	return /^[a-z0-9 ]+$/.test(words) ? words.charAt(0).toUpperCase() + words.slice(1) : name;
}

function basename(path: string): string {
	const parts = path.split(/[\\/]/).filter(Boolean);
	return parts[parts.length - 1] ?? path;
}

/** Shortens absolute paths to the last two segments so details stay scannable. */
function shortPath(path: string): string {
	const parts = path.split(/[\\/]/).filter(Boolean);
	return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : parts.join('/');
}

function fileList(files: unknown): string | null {
	if (!Array.isArray(files) || files.length === 0) return null;
	const names = files.map((f) => basename(String(f)));
	return names.length > 3
		? `${names.slice(0, 3).join(', ')} +${names.length - 3}`
		: names.join(', ');
}

const LEADING_CD = /^cd\s+("[^"]*"|'[^']*'|\S+)\s*(?:;|&&)\s*/;

// Coding agents (T3) report tools they don't classify as a free-form title,
// e.g. "Read C:/repo/file.ts" or "Round 1 sidebar review".
const TITLE_VERBS: [RegExp, string, ToolKind][] = [
	[/^read\s+(.+)$/i, 'Read', 'read'],
	[/^(?:write|create)\s+(.+)$/i, 'Wrote', 'edit'],
	[/^(?:grep|search)\s+(.+)$/i, 'Searched', 'search'],
	[/^(?:glob|find)\s+(.+)$/i, 'Found files', 'search'],
	[/^(?:fetch|webfetch)\s+(.+)$/i, 'Fetched', 'web']
];

export function describeTool(name: string, input: unknown): ToolDisplay {
	const args = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
	const meta = TOOL_META[name];
	if (meta) {
		const builtin = meta.server === 'coding' ? null : meta.server;
		if (name === 'edit_files' || name === 'checkpoint') {
			return {
				label: meta.label,
				detail: fileList(args.files),
				kind: meta.kind,
				server: null,
				prose: false
			};
		}
		let detail = meta.detail ? oneLine(args[meta.detail]) : compactArgs(args);
		if (name === 'question' || name === 'AskUserQuestion') detail = firstQuestion(args.questions);
		if (detail && meta.detail && PATH_FIELDS.has(meta.detail)) detail = shortPath(detail);
		if (name === 'TodoWrite') detail = todoSummary(args.todos);
		// Agents prefix most commands with `cd <repo> &&`; the directory rarely matters.
		if (detail && meta.kind === 'command') detail = detail.replace(LEADING_CD, '') || detail;
		// A step title stored as a command ("Preparing workspace") reads best as the label itself.
		if (meta.kind === 'command' && isTitle(detail)) {
			return { label: detail!, detail: null, kind: meta.kind, server: null, prose: true };
		}
		const prose = PROSE_KINDS.has(meta.kind);
		// Prompts quote commands in markdown backticks; plain text reads better in a row.
		if (detail && prose) detail = detail.replace(/`/g, '');
		return { label: meta.label, detail, kind: meta.kind, server: builtin, prose };
	}
	if (args.kind === 'subagent') {
		return { label: 'Subagent', detail: name, kind: 'subagent', server: null, prose: true };
	}
	const mcp = MCP_NAME.exec(name);
	if (mcp) {
		// MCP tools from the coding agent's servers: name the tool, show its arguments.
		return {
			label: humanize(mcp[2]),
			detail: compactArgs(args) ?? mcp[1],
			kind: 'tool',
			server: null,
			prose: false
		};
	}
	for (const [pattern, label, kind] of TITLE_VERBS) {
		const match = pattern.exec(name);
		if (match) {
			return { label, detail: shortPath(match[1].trim()), kind, server: null, prose: false };
		}
	}
	const generic = args.kind === 'dynamic_tool' || args.kind === 'checkpoint';
	return {
		label: humanize(name),
		detail: compactArgs(args),
		kind: 'tool',
		server: null,
		// Coding agents report unclassified steps by title only ("Round 1 review").
		prose: generic
	};
}

/**
 * True when the row's detail already shows the whole input (e.g. a short command
 * or a single query), so an expanded view doesn't need to repeat it.
 */
export function detailCoversInput(input: unknown, detail: string | null): boolean {
	if (!detail || detail.length > 80 || !input || typeof input !== 'object') return false;
	const args = input as Record<string, unknown>;
	const values = Object.entries(args).filter(([key]) => key !== 'kind');
	if (values.length === 1 && oneLine(values[0][1]) === detail) return true;
	return compactArgs(args) === detail;
}

/** "3 of 5 done" for a TodoWrite list. */
function todoSummary(todos: unknown): string | null {
	if (!Array.isArray(todos) || todos.length === 0) return null;
	const done = todos.filter((t) => (t as { status?: unknown })?.status === 'completed').length;
	return `${done} of ${todos.length} done`;
}

function firstQuestion(questions: unknown): string | null {
	if (!Array.isArray(questions)) return null;
	const first = questions[0] as { question?: unknown; header?: unknown } | undefined;
	return oneLine(first?.question ?? first?.header ?? null);
}

export interface ToolOutcome {
	label: string;
	negative: boolean;
}

/** How an approval request or question was resolved, from its recorded decision. */
export function toolOutcome(name: string, output: unknown): ToolOutcome | null {
	if (name !== 'approval' && name !== 'question') return null;
	const result = output as { decision?: unknown; status?: unknown } | null | undefined;
	const value = result?.decision ?? result?.status;
	if (typeof value !== 'string' || !value) return null;
	if (/^accept/i.test(value)) return { label: 'Approved', negative: false };
	if (/^(decline|deny|reject)/i.test(value)) return { label: 'Declined', negative: true };
	if (/^cancel/i.test(value)) return { label: 'Cancelled', negative: true };
	if (name === 'question') return { label: 'Answered', negative: false };
	return { label: value.charAt(0).toUpperCase() + value.slice(1), negative: false };
}

interface ToolPartLike {
	state: string;
	output?: unknown;
}

/** True when the call failed, including MCP results flagged `isError` and non-zero exit codes. */
export function toolFailed(part: ToolPartLike): boolean {
	if (part.state === 'output-error') return true;
	if (part.state !== 'output-available' || !part.output || typeof part.output !== 'object') {
		return false;
	}
	const output = part.output as { isError?: unknown; exitCode?: unknown };
	if (output.isError === true) return true;
	return typeof output.exitCode === 'number' && output.exitCode !== 0;
}

export type SubagentPhase = 'running' | 'done' | 'failed' | 'stopped';

function firstLine(text: unknown): string | null {
	if (typeof text !== 'string') return null;
	let heading: string | null = null;
	for (const raw of text.split('\n')) {
		// Drop markdown markers so a "- item" line reads as plain text.
		const line = raw
			.replace(/^[#>*\-\s]+/, '')
			.replace(/\*\*/g, '')
			.trim();
		if (!line) continue;
		// A heading ("## Findings") says less than the line under it.
		if (/^\s*#/.test(raw)) {
			heading ??= line;
			continue;
		}
		return line;
	}
	return heading;
}

// Claude Code subagents hand their report straight to the parent agent, which
// leaves only this notice as the tool result.
const HANDBACK_NOTICE = /report was delivered to you as a message/i;

/**
 * The second line under a subagent: what it's doing while it runs, and what it
 * came back with once it's done.
 */
export function subagentActivity(
	input: unknown,
	output: unknown,
	phase: SubagentPhase
): string | null {
	const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
	const task = firstLine(args.prompt);
	if (phase === 'running') return firstLine(args.progress) ?? task;
	if (phase === 'stopped') return firstLine(args.progress) ?? task;
	if (phase === 'failed') return firstLine(output) ?? task;
	const result = typeof output === 'string' ? output : null;
	if (result && HANDBACK_NOTICE.test(result)) return 'Reported back to the main agent';
	return firstLine(result) ?? firstLine(args.subagent_type) ?? task;
}
