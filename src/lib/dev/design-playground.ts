/**
 * Design playground: a hand-written conversation that exercises every way a
 * message can render — markdown, widgets, reasoning, attachments, every
 * builtin MCP tool, coding-agent (T3) items, and error / partial states.
 *
 * Seed it into the local database with `pnpm seed:playground --email <you>`
 * and open the printed URL. When you add a builtin tool, widget or part kind,
 * add an example here; `design-playground.spec.ts` fails for tools that are
 * missing.
 *
 * Must stay dependency-free (type imports only) so the seed script can load
 * it with plain Node.
 */
import type { MessageUsage } from '$lib/types.js';

export interface PlaygroundMessage {
	role: 'user' | 'assistant';
	parts: unknown[];
	status?: 'complete' | 'partial' | 'failed';
	error?: string;
	usage?: MessageUsage;
}

export const PLAYGROUND_TITLE = 'Design playground';

let callSeq = 0;
function callId(): string {
	callSeq += 1;
	return `playground-call-${String(callSeq).padStart(3, '0')}`;
}

const text = (value: string) => ({ type: 'text', text: value, state: 'done' });
const reasoning = (value: string) => ({ type: 'reasoning', text: value, state: 'done' });
const user = (value: string): PlaygroundMessage => ({ role: 'user', parts: [text(value)] });

/** A builtin MCP tool call, shaped like the AI SDK stores it. */
function mcp(
	toolName: string,
	input: Record<string, unknown>,
	output: unknown,
	opts: { isError?: boolean } = {}
) {
	const body = typeof output === 'string' ? output : JSON.stringify(output);
	return {
		type: 'dynamic-tool',
		toolName,
		toolCallId: callId(),
		state: 'output-available',
		input,
		output: { content: [{ type: 'text', text: body }], isError: opts.isError ?? false },
		toolMetadata: { clientName: 'ai-sdk-mcp-client', toolName }
	};
}

/** A coding-agent (T3) item, shaped like `src/lib/server/t3/projection.ts` renders it. */
function t3(toolName: string, input: Record<string, unknown>, output: unknown) {
	return {
		type: 'dynamic-tool',
		toolName,
		toolCallId: callId(),
		state: 'output-available',
		input,
		output
	};
}

const fence = (lang: string, value: unknown) =>
	'```' + lang + '\n' + JSON.stringify(value, null, 2) + '\n```';

const usage: MessageUsage = {
	providerId: 'playground',
	modelId: 'playground/model-large',
	inputTokens: 18432,
	outputTokens: 1210,
	totalTokens: 19642,
	latencyMs: 14200,
	costUsd: 0.0421,
	promptChars: { system: 4200, skills: 1800, tools: 9100, messages: 22000 }
};

const WEATHER = {
	location: {
		name: 'Lisbon',
		country: 'Portugal',
		admin1: 'Lisbon',
		timezone: 'Europe/Lisbon'
	},
	current: { temp: 21.4, feels: 20.9, humidity: 61, precip: 0, wind: 14.2, windDir: 300, code: 2 },
	units: { temp: '°C', wind: 'km/h', precip: 'mm' },
	daily: [
		{
			date: '2026-11-07',
			code: 2,
			tmin: 14.1,
			tmax: 22.0,
			precipSum: 0,
			precipProb: 5,
			windMax: 18
		},
		{
			date: '2026-11-08',
			code: 61,
			tmin: 13.6,
			tmax: 19.2,
			precipSum: 4.2,
			precipProb: 70,
			windMax: 24
		},
		{
			date: '2026-11-09',
			code: 3,
			tmin: 12.9,
			tmax: 18.4,
			precipSum: 0.3,
			precipProb: 20,
			windMax: 16
		},
		{
			date: '2026-11-10',
			code: 0,
			tmin: 12.0,
			tmax: 20.1,
			precipSum: 0,
			precipProb: 0,
			windMax: 11
		},
		{
			date: '2026-11-11',
			code: 95,
			tmin: 13.3,
			tmax: 17.8,
			precipSum: 12.5,
			precipProb: 90,
			windMax: 38
		}
	]
};

const LONG_COMMAND_OUTPUT = Array.from(
	{ length: 60 },
	(_, i) =>
		`  ✓ src/lib/server/module-${String(i + 1).padStart(2, '0')}.spec.ts (${(i % 7) + 2} tests) ${12 + i * 3}ms`
).join('\n');

function markdownShowcase(): PlaygroundMessage[] {
	return [
		user('Show me every kind of formatting you can produce.'),
		{
			role: 'assistant',
			usage,
			parts: [
				reasoning(
					'The user wants a formatting reference. I will cover headings, lists, a table, code, quotes, math and a diagram so every renderer is exercised.'
				),
				text(
					[
						'# Heading 1',
						'A paragraph with **bold**, _italic_, `inline code`, ~~strikethrough~~ and a [link](https://example.com). Long paragraphs need comfortable line length and leading so that reading several screens of agent output stays pleasant rather than tiring — this sentence is intentionally long to check wrapping.',
						'## Heading 2',
						'### Heading 3',
						'- Unordered item',
						'- Item with nested list',
						'  - Nested item one',
						'  - Nested item two',
						'',
						'1. Ordered item',
						'2. Second ordered item',
						'',
						'- [x] Finished task',
						'- [ ] Open task',
						'',
						'> A blockquote that spans a sentence or two, used for callouts and quoted sources.',
						'',
						'| Tool | Server | Calls | Avg. latency |',
						'| --- | --- | ---: | ---: |',
						'| fs_read | fs | 128 | 12 ms |',
						'| fetch | webfetch | 41 | 830 ms |',
						'| get_weather | weather | 9 | 410 ms |',
						'',
						'```ts',
						'export function greet(name: string): string {',
						'\treturn `Hello, ${name}!`;',
						'}',
						'```',
						'',
						'Inline math $$E = mc^2$$ and a block:',
						'',
						'$$',
						'\\int_0^1 x^2 \\, dx = \\frac{1}{3}',
						'$$',
						'',
						'```mermaid',
						'flowchart LR',
						'  User --> Chat --> Tools',
						'  Tools --> Chat',
						'```',
						'',
						'---',
						'',
						'A final line after a horizontal rule.'
					].join('\n')
				)
			]
		}
	];
}

function widgets(): PlaygroundMessage[] {
	return [
		user('Weather in Lisbon, a chart of tool usage, a map of nice cafés and the report file.'),
		{
			role: 'assistant',
			parts: [
				mcp('get_weather', { location: 'Lisbon', days: 5 }, WEATHER),
				text('Here is the forecast:\n\n' + fence('weather', WEATHER)),
				text(
					fence('chart', {
						type: 'bar',
						title: 'Tool calls per day',
						labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
						datasets: [
							{ label: 'fs', data: [12, 19, 8, 15, 22] },
							{ label: 'webfetch', data: [5, 9, 4, 11, 7] }
						]
					}) +
						'\n\n' +
						fence('chart', {
							type: 'line',
							title: 'Latency (ms)',
							labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
							datasets: [{ label: 'p50', data: [320, 280, 410, 300, 260] }]
						}) +
						'\n\n' +
						fence('chart', {
							type: 'pie',
							title: 'Share by server',
							labels: ['fs', 'webfetch', 'math'],
							datasets: [{ data: [55, 30, 15] }]
						})
				),
				text(
					fence('map', {
						title: 'Cafés in Lisbon',
						markers: [
							{
								name: 'Café A Brasileira',
								lat: 38.7107,
								lng: -9.1424,
								address: 'R. Garrett 120',
								rating: 4.3
							},
							{
								name: 'Fábrica Coffee Roasters',
								lat: 38.7163,
								lng: -9.1428,
								notes: 'Great flat white'
							}
						]
					})
				),
				text(
					'The report is ready:\n\n' + fence('file', { name: 'report.html', path: 'report.html' })
				),
				text(
					'Your recent chats:\n\n' +
						fence('chats', {
							title: 'Updated this week',
							chats: [
								{
									id: 'c-1',
									title: 'Side Panel: Coding Tasks vs Chat',
									updatedAt: Date.now() - 2 * 3600_000,
									summary: 'Decided to group coding tasks above chats in the sidebar.'
								},
								{
									id: 'c-2',
									title: 'Fix the flaky upload test',
									updatedAt: Date.now() - 5 * 60_000,
									coding: {
										project: 'ai-chat',
										status: 'running',
										model: 'gpt-5.5',
										branch: 'fix/flaky-upload',
										linesAdded: 48,
										linesRemoved: 12
									}
								},
								{
									id: 'c-3',
									title: 'Migrate settings pages',
									updatedAt: Date.now() - 26 * 3600_000,
									coding: {
										project: 'ai-chat',
										status: 'awaiting_input',
										branch: 'feat/settings-redesign',
										pullRequest: 'https://github.com/Kellojo/ai-chat/pull/6',
										linesAdded: 310,
										linesRemoved: 95,
										waitingFor: { kind: 'approval', title: 'Run pnpm install?' }
									}
								}
							]
						})
				)
			]
		}
	];
}

function attachments(): PlaygroundMessage[] {
	return [
		{
			role: 'user',
			parts: [
				{ type: 'file', mediaType: 'image/png', url: '/pwa-512x512.png', filename: 'logo.png' },
				{ type: 'file', mediaType: 'application/pdf', url: '/robots.txt', filename: 'spec.pdf' },
				text('Here is our logo and the spec. Can you make a sunrise version of the logo?')
			]
		},
		{
			role: 'assistant',
			parts: [
				mcp(
					'generate_image',
					{ prompt: 'App logo at sunrise, soft pastel palette', size: '1024x1024' },
					'Generated 1 image(s): 3f1c-generated.png'
				),
				mcp(
					'edit_image',
					{ prompt: 'Make the sky warmer', image: '3f1c-generated.png' },
					'error: image generation failed: Request contains an invalid argument.',
					{ isError: true }
				),
				text(
					'Generated the image, but the follow-up edit failed — the provider rejected the request.\n\n![Sunrise logo](/pwa-192x192.png)'
				)
			]
		}
	];
}

/** One example call for every builtin MCP tool, grouped by server. */
export const BUILTIN_TOOL_EXAMPLES: Record<string, ReturnType<typeof mcp>[]> = {
	webfetch: [
		mcp(
			'fetch',
			{ url: 'https://example.com', format: 'markdown' },
			'# Example Domain\n\nThis domain is for use in illustrative examples in documents.'
		)
	],
	datetime: [
		mcp(
			'now',
			{},
			{ iso: '2026-11-07T17:02:11+01:00', timezone: 'Europe/Berlin', human: '2026-11-07 17:02' }
		),
		mcp(
			'format',
			{ iso: '2026-11-07T16:02:11Z', fmt: 'cccc, d LLLL', tz: 'Europe/Berlin' },
			'Saturday, 7 November'
		),
		mcp(
			'convert',
			{ iso: '2026-11-07T17:00:00', from: 'Europe/Berlin', to: 'America/New_York' },
			'2026-11-07T11:00:00-05:00'
		)
	],
	'chat-search': [
		mcp('search_chats', { query: 'sidebar' }, [
			{ id: 'c-1', title: 'Side Panel: Coding Tasks vs Chat', updatedAt: 1794067922836 }
		]),
		mcp('read_chat', { conversationId: 'c-1' }, [
			{ role: 'user', text: 'Make the sidebar look like an inbox', status: 'complete' }
		])
	],
	fs: [
		mcp('fs_ls', { scope: 'workspace' }, 'src/\nREADME.md\npackage.json'),
		mcp('fs_read', { scope: 'workspace', path: 'README.md' }, '# Chatty\n\nSelf-hosted AI chat.\n'),
		mcp(
			'fs_read',
			{ scope: 'workspace', path: 'package.json', head: 3 },
			'{\n\t"name": "chatty",\n\t"private": true,'
		),
		mcp(
			'fs_read',
			{ scope: 'workspace', path: 'server.log', tail: 2 },
			'GET /api/chat 200\nGET /usage 200'
		),
		mcp('fs_read', { scope: 'workspace', path: 'README.md', stats: true }, '3 5 31 README.md'),
		mcp(
			'fs_grep',
			{ scope: 'workspace', pattern: 'TODO' },
			'src/app.ts:12: // TODO: handle retries'
		),
		mcp('fs_glob', { scope: 'workspace', pattern: '**/*.md' }, ['README.md', 'docs/setup.md']),
		mcp(
			'fs_write',
			{ scope: 'workspace', path: 'notes.md', content: '# Notes\n' },
			'wrote notes.md (8 bytes)'
		),
		mcp(
			'fs_edit',
			{ scope: 'workspace', path: 'notes.md', old: '# Notes', new: '# Meeting notes' },
			'edited notes.md'
		),
		mcp('fs_mkdir', { scope: 'workspace', path: 'drafts' }, 'created drafts'),
		mcp('fs_rm', { scope: 'workspace', path: 'old.txt' }, 'error: not a file: old.txt', {
			isError: true
		}),
		mcp(
			'fs_curl',
			{ scope: 'workspace', url: 'https://example.com/data.csv', path: 'data.csv' },
			'data.csv 18234 bytes'
		)
	],
	settings: [
		mcp('list_settings', {}, { 'websearch.default_limit': 5, 'websearch.language': 'auto' }),
		mcp('get_setting', { key: 'websearch.language' }, 'auto'),
		mcp(
			'update_setting',
			{ key: 'websearch.default_limit', value: 8 },
			'updated websearch.default_limit'
		)
	],
	memory: [
		mcp('search_memory', { query: 'coffee' }, [
			{
				path: 'preferences.md',
				title: 'Preferences',
				snippet: '…prefers <mark>coffee</mark> over tea…'
			}
		]),
		mcp('list_concepts', {}, [
			{ path: 'preferences.md', title: 'Preferences' },
			{ path: 'projects/chatty.md', title: 'Chatty', description: 'Self-hosted AI chat app' }
		]),
		mcp(
			'read_concept',
			{ path: 'preferences.md' },
			{
				path: 'preferences.md',
				frontmatter: { title: 'Preferences', tags: ['personal'] },
				body: 'Prefers coffee over tea. Works in Europe/Berlin.'
			}
		),
		mcp(
			'create_concept',
			{
				path: 'projects/playground.md',
				title: 'Design playground',
				body: 'Seeded conversation for UI review.'
			},
			'created projects/playground.md'
		),
		mcp(
			'update_concept',
			{ path: 'projects/playground.md', body: 'Seeded conversation covering every widget.' },
			'updated projects/playground.md'
		),
		mcp('delete_concept', { path: 'scratch.md' }, 'deleted scratch.md')
	],
	agents: [
		mcp('list_agents', {}, [
			{ id: 'a-1', name: 'memory-cleanup', triggerType: 'event', enabled: true, builtin: true }
		]),
		mcp('get_agent', { agentId: 'missing' }, 'error: agent not found', { isError: true }),
		mcp(
			'create_agent',
			{
				name: 'daily-digest',
				systemPrompt: 'Summarise yesterday’s chats.',
				triggerType: 'schedule'
			},
			{ id: 'a-2', name: 'daily-digest' }
		),
		mcp('update_agent', { agentId: 'a-2', enabled: false }, { id: 'a-2', enabled: false }),
		mcp('delete_agent', { agentId: 'a-2' }, 'deleted agent a-2'),
		mcp(
			'start_agent',
			{ agentId: 'a-1', wait: true },
			{
				run: {
					id: 'r-1',
					agentId: 'a-1',
					userId: 'u-1',
					trigger: 'manual',
					status: 'success',
					conversationId: 'c-1',
					error: null,
					startedAt: 1_760_000_000_000,
					endedAt: 1_760_000_083_000
				},
				agent: { id: 'a-1', name: 'Meal Planner' },
				runPath: '/agents/a-1/runs/r-1',
				chatPath: null,
				result: '## This week’s dinners\n\n- **Mon:** Lemon chickpea pasta\n- **Tue:** Miso salmon',
				question: null,
				note: 'The run finished. Summarise its result for the user.'
			}
		),
		mcp(
			'get_agent_run',
			{ runId: 'r-2' },
			{
				run: {
					id: 'r-2',
					agentId: 'a-1',
					userId: 'u-1',
					trigger: 'manual',
					status: 'awaiting_input',
					conversationId: 'c-2',
					error: null,
					startedAt: 1_760_000_000_000,
					endedAt: 1_760_000_031_000
				},
				agent: { id: 'a-1', name: 'Meal Planner' },
				runPath: '/agents/a-1/runs/r-2',
				chatPath: '/chat/c-2',
				result: null,
				question: 'Should I plan a vegetarian week?',
				note: "The agent stopped to ask the user a question. Relay it; the user answers in the run's chat (chatPath)."
			}
		)
	],
	skills: [
		mcp(
			'load_skill',
			{ name: 'draft-email' },
			{ name: 'draft-email', title: 'Draft email', body: 'Draft an email…' }
		),
		mcp(
			'read_skill_reference',
			{ name: 'research-topic', path: 'references/source-quality.md' },
			'# Source quality ranking\n\n1. Primary sources\n2. Primary reporting'
		),
		mcp(
			'create_skill',
			{ name: 'weekly-review', description: 'Run a weekly review', body: '## Steps\n…' },
			'created skill: weekly-review'
		),
		mcp(
			'update_skill',
			{ name: 'weekly-review', description: 'Run a structured weekly review' },
			'updated skill: weekly-review'
		),
		mcp('delete_skill', { name: 'weekly-review' }, 'deleted skill: weekly-review')
	],
	'code-exec': [
		mcp(
			'code_exec',
			{ code: 'const xs = [3, 1, 2];\nconsole.log(xs.sort());' },
			'Console output:\n[ 1, 2, 3 ]\n'
		)
	],
	image: [],
	wait: [mcp('wait', { seconds: 10 }, { waitedSeconds: 10, currentTime: '2026-11-07T16:02:21Z' })],
	math: [
		mcp('calculate', { expression: '(2^10 - 24) / sqrt(16)' }, '250'),
		mcp('calculate', { expression: '1 / 0' }, 'error: division by zero', { isError: true }),
		mcp(
			'statistics',
			{ values: [4, 2, 8] },
			'{"count":3,"sum":14,"mean":4.666666666666667,"median":4,"min":2,"max":8,"variance":6.222222222222222,"stdev":2.494438257849294}'
		),
		mcp('convert_units', { value: 50, from: 'km', to: 'mile' }, '31.068559611866696'),
		mcp(
			'convert_many',
			{
				conversions: [
					{ value: 1, from: 'kg', to: 'lb' },
					{ value: 30, from: 'C', to: 'F' }
				]
			},
			['2.2046226218487757', '86']
		),
		mcp('list_units', { category: 'length' }, ['m', 'km', 'cm', 'mm', 'mile', 'yard', 'ft', 'in'])
	],
	weather: [mcp('get_weather', { location: 'Lisbon', days: 5 }, WEATHER)]
};

// Image tools appear in `attachments()` with realistic surroundings; list them
// here too so coverage is visible in one place.
BUILTIN_TOOL_EXAMPLES.image = [
	mcp(
		'generate_image',
		{ prompt: 'A lighthouse at dawn' },
		'Generated 1 image(s): a1-generated.png'
	),
	mcp(
		'edit_image',
		{ prompt: 'Add fog', image: 'a1-generated.png' },
		'Generated 1 image(s): a2-generated.png'
	)
];

function builtinTools(): PlaygroundMessage[] {
	const messages: PlaygroundMessage[] = [];
	for (const [server, calls] of Object.entries(BUILTIN_TOOL_EXAMPLES)) {
		if (calls.length === 0) continue;
		messages.push(user(`Try every ${server} tool.`));
		messages.push({
			role: 'assistant',
			parts: [
				...calls,
				text(
					`Ran ${calls.length} ${server} tool${calls.length === 1 ? '' : 's'}. Failed calls are shown with their error.`
				)
			]
		});
	}
	return messages;
}

/** A long coding-agent turn, like the ones mirrored from T3 Code. */
function codingSession(): PlaygroundMessage[] {
	const parts: unknown[] = [
		t3(
			'run_command',
			{ command: 'Preparing workspace' },
			{ exitCode: 0, note: 'Output not loaded' }
		),
		reasoning(
			'I need to understand how the sidebar is built before changing it. Reading the component and the data model first.\n\n'
		),
		text('Reading the sidebar and the coding-task data model before making the first version.'),
		t3(
			'Read',
			{ file_path: 'C:\\repo\\src\\lib\\components\\app\\Sidebar.svelte' },
			'1\t<script lang="ts">\n2\t\timport { onMount } from "svelte";'
		),
		t3(
			'ToolSearch',
			{ query: 'select:mcp__t3-code__preview_open,mcp__t3-code__preview_snapshot', max_results: 2 },
			{ matches: ['mcp__t3-code__preview_open', 'mcp__t3-code__preview_snapshot'] }
		),
		t3(
			'mcp__t3-code__preview_open',
			{ url: 'http://localhost:5173/' },
			{ tabId: 'tab_1', title: 'Chatty' }
		),
		t3(
			'Grep',
			{ pattern: 'coding_status', path: 'src/lib' },
			'src/lib/server/db/repo/conversations.ts'
		),
		t3(
			'TodoWrite',
			{
				todos: [
					{ content: 'Read sidebar', status: 'completed' },
					{ content: 'Add icons', status: 'in_progress' },
					{ content: 'Unread state', status: 'pending' }
				]
			},
			{ ok: true }
		),
		// Older synced chats only kept the item kind; they still need to render.
		t3('dynamic_tool', { kind: 'dynamic_tool' }, { status: 'completed' }),
		t3(
			'run_command',
			{ command: 'git status --short && git diff --stat' },
			{
				exitCode: 0,
				output:
					' M src/lib/components/app/Sidebar.svelte\n 1 file changed, 42 insertions(+), 8 deletions(-)'
			}
		),
		t3(
			'todo_list',
			{
				steps: [
					{ step: 'Read sidebar and data model', status: 'completed' },
					{ step: 'Mark coding tasks with an icon', status: 'in_progress' },
					{ step: 'Add unread / needs-attention state', status: 'pending' }
				]
			},
			{ ok: true }
		)
	];
	for (let i = 1; i <= 12; i++) {
		parts.push(
			reasoning(`Round ${i}: checking the screenshot for spacing and contrast issues.\n\n`),
			t3(
				'Read',
				{ file_path: `C:/Users/me/AppData/Local/Temp/scratchpad/shots/r${i}-light.png` },
				{ note: 'Output not loaded' }
			),
			t3(
				'subagent',
				{ description: `Round ${i} sidebar review`, prompt: 'Review the sidebar screenshots…' },
				`SCORE: ${(7 + i * 0.15).toFixed(1)}/10
1. MAJOR: tighten row spacing.`
			),
			t3(
				'edit_files',
				{ files: ['src/lib/components/app/Sidebar.svelte', 'src/routes/layout.css'] },
				{ additions: 10 + i, deletions: i }
			),
			t3(
				'run_command',
				{ command: 'pnpm check && pnpm lint' },
				{ exitCode: 0, output: 'svelte-check found 0 errors and 0 warnings' }
			)
		);
		if (i % 4 === 0)
			parts.push(text(`Round ${i} done. Score went up; continuing with the remaining nits.`));
	}
	parts.push(
		t3(
			'run_command',
			{ command: 'pnpm test:unit -- --run' },
			{ exitCode: 0, output: LONG_COMMAND_OUTPUT }
		),
		t3(
			'run_command',
			{ command: 'pnpm build' },
			{ exitCode: 1, output: 'error during build:\nsrc/app.ts(3,1): Cannot find module "x"' }
		),
		t3('web_search', { query: 'svelte 5 runes $derived.by' }, { done: true }),
		t3('file_search', { pattern: 'Sidebar' }, { done: true }),
		t3(
			'approval',
			{ request: 'Run `git push origin feat/sidebar`?', reason: 'Pushes the branch to GitHub' },
			{ decision: 'accept' }
		),
		t3(
			'question',
			{
				questions: [
					{
						id: 'q1',
						question: 'Keep the diff stat in the sidebar?',
						options: [{ label: 'Yes' }, { label: 'No' }]
					}
				]
			},
			{ status: 'answered' }
		),
		{
			type: 'dynamic-tool',
			toolName: 'error',
			toolCallId: callId(),
			state: 'output-error',
			input: {},
			errorText: 'The coding agent reported an error: rate limit exceeded, retrying in 30s'
		},
		// A background subagent still at work after its parent turn ended.
		{
			type: 'dynamic-tool',
			toolName: 'subagent',
			toolCallId: callId(),
			state: 'input-available',
			input: {
				description: 'Bump deps, fix pnpm audit',
				prompt: 'Bump the dependencies, prioritising what pnpm audit flags.',
				progress: 'Running pnpm install after the SvelteKit bump',
				provider: 'claudeAgent',
				running: true,
				startedAt: Date.now() - 95_000
			}
		},
		t3(
			'subagent',
			{
				description: 'Security audit of the T3 routes',
				prompt: 'Review the T3 routes for auth gaps.',
				provider: 'claudeAgent',
				startedAt: Date.now() - 400_000,
				completedAt: Date.now() - 262_000
			},
			'## Findings\n- **High**: settle endpoint lacks an ownership check'
		),
		t3(
			'checkpoint',
			{ files: ['src/lib/components/app/Sidebar.svelte', 'src/routes/layout.css'] },
			{ additions: 42, deletions: 8 }
		),
		text(
			'Done. The sidebar now separates coding tasks from chats, shows an unread dot for finished runs and keeps the run timer.\n\n- `Sidebar.svelte`: icons, unread state, spacing\n- `layout.css`: shared running indicator colour'
		)
	);
	return [
		user(
			'For the side panel, use the hill climbing skill to improve it and make clear what is a coding task and what a regular chat'
		),
		{ role: 'assistant', parts, usage }
	];
}

function edgeCases(): PlaygroundMessage[] {
	const longWord = 'https://example.com/' + 'very-long-path-segment-'.repeat(12);
	return [
		user(
			'A very long user message to check wrapping and bubble width. ' +
				'It keeps going with several sentences so it spans multiple lines on desktop and many on mobile. ' +
				`It also contains an unbreakable URL: ${longWord}\n\nAnd a second paragraph after a blank line.`
		),
		{
			role: 'assistant',
			parts: [
				text(
					`Unbreakable content must wrap instead of overflowing: ${longWord}

Inline JSON without spaces too: {"title":"optional","center":[38.7223,-9.1393],"zoom":13,"markers":[{"name":"required","lat":38.7223,"lng":-9.1393,"address":"optional"}]}`
				),
				{
					type: 'dynamic-tool',
					toolName: 'fetch',
					toolCallId: callId(),
					state: 'input-available',
					input: { url: 'https://slow.example.com' }
				}
			],
			status: 'partial'
		},
		user('Try again please.'),
		{
			role: 'assistant',
			parts: [reasoning('Retrying the request…')],
			status: 'failed',
			error: 'Provider error: 503 Service Unavailable'
		},
		user('Unknown tools from user-added MCP servers?'),
		{
			role: 'assistant',
			parts: [
				mcp('list_recipes', { search: 'pasta' }, { recipes: [], total: 0 }),
				mcp('health_check', {}, 'Error checking health: 404 Not Found', { isError: true }),
				text('Tools from user-added MCP servers get a readable name derived from their id.')
			]
		}
	];
}

/**
 * A coding-agent turn caught mid-run: nine steps, the last one still running.
 * Live states only exist while streaming, so they can't be seeded; component
 * specs render this instead (see ActivityGroup.svelte.spec.ts).
 */
export function buildLiveActivity(): unknown[] {
	return [
		reasoning('Checking which files render tool calls.'),
		t3('run_command', { command: 'git status --short' }, { exitCode: 0, output: ' M a.ts' }),
		t3('Read', { file_path: 'src/lib/components/app/MessageTimeline.svelte' }, 'file contents'),
		t3('edit_files', { files: ['src/lib/tool-meta.ts'] }, { additions: 12, deletions: 3 }),
		t3('run_command', { command: 'pnpm check' }, { exitCode: 0, output: '0 errors' }),
		t3('run_command', { command: 'pnpm lint' }, { exitCode: 0, output: 'ok' }),
		t3('subagent', { description: 'Round 1 review', prompt: 'Review the change' }, 'SCORE: 8/10'),
		reasoning('The reviewer asked for visible focus styles; applying them now.'),
		{
			type: 'dynamic-tool',
			toolName: 'run_command',
			toolCallId: callId(),
			state: 'input-available',
			input: { command: 'pnpm test:unit -- --run' }
		}
	];
}

/** Playground sections; seed them separately to review one area in a short chat. */
export const PLAYGROUND_SECTIONS: { name: string; build: () => PlaygroundMessage[] }[] = [
	{ name: 'Markdown', build: markdownShowcase },
	{ name: 'Widgets', build: widgets },
	{ name: 'Attachments', build: attachments },
	{ name: 'Builtin tools', build: builtinTools },
	{ name: 'Coding agent', build: codingSession },
	{ name: 'Edge cases', build: edgeCases }
];

/** The full playground conversation, oldest message first. */
export function buildDesignPlayground(): PlaygroundMessage[] {
	return PLAYGROUND_SECTIONS.flatMap((section) => section.build());
}
