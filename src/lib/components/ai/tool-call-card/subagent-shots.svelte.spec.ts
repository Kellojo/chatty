import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { commands, page as browserPage } from 'vitest/browser';
import { setMode } from 'mode-watcher';
import '../../../../routes/layout.css';
import Harness from './SubagentShotHarness.svelte';
import TranscriptPage from '../../../../routes/(app)/subagents/[id]/+page.svelte';

/**
 * Screenshots of the subagent flow (timeline rows and the transcript page):
 * `VITE_SUBAGENT_SHOTS=<dir> pnpm exec vitest run --project client subagent-shots`.
 */
const SHOTS = import.meta.env.VITE_SUBAGENT_SHOTS as string | undefined;

// The test bundle gets its own copy of Svelte inside stick-to-bottom, whose effects then
// have no owner; the shots don't need sticky scrolling, so a still scroller stands in.
vi.mock('stick-to-bottom-svelte', () => ({
	StickToBottom: class {
		isAtBottom = true;
		isNearBottom = true;
		escapedFromLock = false;
		scrollTop = 0;
		targetScrollTop = 0;
		scrollToBottom() {
			return Promise.resolve(true);
		}
		stopScroll() {}
	}
}));

const mcp = (body: unknown, isError = false) => ({
	content: [{ type: 'text', text: JSON.stringify(body) }],
	isError
});
const NOW = Date.now();
const input = {
	description: 'Compare vector databases',
	prompt:
		'Compare pgvector, Qdrant and LanceDB for a self-hosted app with ~1M embeddings: setup effort, query speed, filtering and backups. Report a short table and a recommendation.'
};
const REPORT = [
	'**Recommendation: pgvector**, since the app already runs Postgres and 1M vectors is well within its range.',
	'',
	'| | Setup | Filtering | Backups |',
	'|---|---|---|---|',
	'| pgvector | none (extension) | full SQL | with Postgres |',
	'| Qdrant | one container | rich payload filters | snapshots |',
	'| LanceDB | embedded library | basic | plain files |',
	'',
	'```sql',
	'CREATE INDEX ON items USING hnsw (embedding vector_cosine_ops);',
	'```',
	'',
	'Sources: pgvector README, Qdrant docs (filtering), LanceDB docs.'
].join('\n');

const tool = (state: string, extra: Record<string, unknown> = {}, toolCallId = 'call-1') => ({
	type: 'dynamic-tool',
	toolName: 'run_subagent',
	toolCallId,
	state,
	input,
	...extra
});

const CHAT_SUBAGENT_ROWS = [
	{ label: 'starting', part: tool('input-available', {}, 'call-start'), active: true },
	{ label: 'working (found)', part: tool('input-available', {}, 'call-live'), active: true },
	{
		label: 'done',
		part: tool('output-available', {
			output: mcp({
				status: 'completed',
				result: REPORT,
				truncated: false,
				error: null,
				conversationId: 'sub-1',
				startedAt: NOW - 83_000,
				endedAt: NOW
			})
		}),
		active: false
	},
	{
		label: 'failed',
		part: tool('output-available', {
			output: mcp(
				{
					status: 'failed',
					result: null,
					truncated: false,
					error: 'The selected model is not available: provider "lmstudio" is unavailable',
					conversationId: 'sub-2',
					startedAt: NOW - 4_000,
					endedAt: NOW
				},
				true
			)
		}),
		active: false
	},
	{
		label: 'refused',
		part: tool('output-available', {
			// As the server's err() sends it: plain text, not JSON.
			output: {
				content: [
					{
						type: 'text',
						text: 'error: 4 subagents are already working for this conversation; wait for one to finish'
					}
				],
				isError: true
			}
		}),
		active: false
	},
	{ label: 'interrupted', part: tool('input-available'), active: false },
	{
		label: 'interrupted (still running)',
		part: tool('input-available', {}, 'call-orphan'),
		active: false
	}
];

// The same agents as a coding task shows its own subagents (Claude Code's Agent tool).
const codingAgent = (state: string, extra: Record<string, unknown> = {}) => ({
	type: 'dynamic-tool',
	toolName: 'Agent',
	toolCallId: 'code-' + state,
	state,
	input: {
		description: 'Find unused exports',
		prompt:
			'Search src/lib for exported functions nobody imports and list them with their file paths.',
		subagent_type: 'Explore',
		// T3 reports when the subagent started and, once done, finished.
		startedAt: NOW - 51_000,
		...(state === 'output-available' ? { completedAt: NOW - 3_000 } : {})
	},
	...extra
});

// Chatty's agent runs (start_agent), which share the same row.
const agentRun = (status: string, extra: Record<string, unknown> = {}) =>
	mcp({
		run: {
			id: 'r-' + status,
			agentId: 'a-1',
			userId: 'u-1',
			trigger: 'manual',
			status,
			conversationId: 'c-run',
			error: status === 'failed' ? 'Provider timed out after 120s' : null,
			startedAt: NOW - 95_000,
			endedAt: status === 'running' ? null : NOW - 2_000
		},
		agent: { id: 'a-1', name: 'Meal Planner' },
		runPath: '/agents/a-1/runs/r-' + status,
		chatPath: status === 'awaiting_input' ? '/chat/c-run' : null,
		result:
			status === 'success'
				? '## This week\n\n- **Mon:** Lemon chickpea pasta\n- **Tue:** Miso salmon'
				: null,
		question: status === 'awaiting_input' ? 'Should I plan a vegetarian week?' : null,
		...extra
	});
const startAgent = (status: string) => ({
	type: 'dynamic-tool',
	toolName: 'start_agent',
	toolCallId: 'agent-' + status,
	state: 'output-available',
	input: { agentId: 'a-1', instructions: "Plan next week's dinners from what is in the fridge." },
	output: agentRun(status)
});

const ROWS = [
	{ label: 'coding task · working', part: codingAgent('input-available'), active: true },
	{
		label: 'coding task · done',
		part: codingAgent('output-available', {
			output:
				'Found 4 unused exports:\n- `formatBytes` in src/lib/formats.ts\n- `slugify` in src/lib/text.ts'
		}),
		active: false
	},
	...CHAT_SUBAGENT_ROWS.map((r) => ({ ...r, label: 'chat subagent · ' + r.label })),
	{ label: 'chat agent run · running', part: startAgent('running'), active: false },
	{ label: 'chat agent run · done', part: startAgent('success'), active: false },
	{ label: 'chat agent run · asking', part: startAgent('awaiting_input'), active: false },
	{ label: 'chat agent run · failed', part: startAgent('failed'), active: false }
];

// The row looks a running subagent up by its tool call.
function stubFetch() {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string) => {
			if (/toolCallId=call-(live|orphan)/.test(String(url))) {
				return new Response(
					JSON.stringify({
						subagent: {
							id: 'sub-live',
							description: input.description,
							parentId: 'chat-1',
							parentTitle: 'Research chat',
							parentIsChat: true,
							status: 'running',
							startedAt: NOW - 42_000,
							endedAt: null,
							error: null,
							progress: {
								steps: 3,
								current: 'Fetched: qdrant.tech/documentation/concepts/filtering'
							}
						}
					})
				);
			}
			return new Response(JSON.stringify({ subagent: null }));
		})
	);
}

// Snapshots are drawn later without the app's web font; one fixed font for both the
// render (where layout is measured) and the snapshot keeps them identical.
const FIXED_FONTS = document.createElement('style');
FIXED_FONTS.textContent = [
	'*{font-family:Arial,Helvetica,sans-serif !important}',
	"code,pre,kbd,samp,.font-mono,.font-mono *{font-family:'Courier New',monospace !important}"
].join('');
document.head.appendChild(FIXED_FONTS);

async function theme(t: 'light' | 'dark') {
	document.documentElement.classList.toggle('dark', t === 'dark');
	setMode(t);
	document.body.style.margin = '0';
	document.body.style.background = 'var(--background)';
}

/**
 * Writes the rendered state as a self-contained HTML file (its DOM plus every
 * stylesheet's rules). The test iframe is drawn scaled down, so its own
 * screenshots come out as thumbnails; a full-size browser shoots these files.
 */
async function shoot(name: string, el: Element, width: number) {
	await new Promise((r) => setTimeout(r, 300));
	const css = [...document.styleSheets]
		.map((sheet) => {
			try {
				return [...sheet.cssRules].map((rule) => rule.cssText).join('\n');
			} catch {
				return '';
			}
		})
		.join('\n');
	const dark = document.documentElement.classList.contains('dark');
	const html = `<!doctype html><html class="${dark ? 'dark' : ''}" style="color-scheme:${dark ? 'dark' : 'light'}"><head><meta charset="utf-8"><style>${css}</style><style>/* The CSSOM drops -webkit-background-clip, which leaves shimmer text transparent in a snapshot: show its resting colour. */.text-shimmer{background:none!important;-webkit-text-fill-color:currentColor!important}</style></head><body style="margin:0;background:var(--background);width:${width}px">${el.outerHTML}</body></html>`;
	await commands.writeFile(`${SHOTS}/${name}.html`, html);
}

describe.skipIf(!SHOTS)('Subagent screenshots', () => {
	for (const vp of [
		{ name: 'desktop', width: 900 },
		{ name: 'mobile', width: 390 }
	]) {
		for (const t of ['light', 'dark'] as const) {
			it(`rows-${vp.name}-${t}`, async () => {
				stubFetch();
				await theme(t);
				await browserPage.viewport(vp.width, 6000);
				const screen = render(Harness, { rows: ROWS });
				await expect.poll(() => screen.container.textContent).toContain('Step 3');
				await shoot(`rows-${vp.name}-${t}`, screen.container.firstElementChild!, vp.width);
			});

			it(`rows-open-${vp.name}-${t}`, async () => {
				stubFetch();
				await theme(t);
				await browserPage.viewport(vp.width, 6000);
				const screen = render(Harness, { rows: ROWS.filter((r) => !r.label.endsWith('starting')) });
				for (const label of [
					'coding task · done',
					'chat subagent · working (found)',
					'chat subagent · done',
					'chat subagent · failed',
					'chat agent run · running',
					'chat agent run · asking'
				]) {
					const button = screen.container.querySelector<HTMLButtonElement>(
						`[data-row="${label}"] button[aria-expanded]`
					);
					button?.click();
				}
				await expect.poll(() => screen.container.textContent).toContain('Result');
				// The working row has found its subagent (the lookup runs after 400ms).
				await expect.poll(() => screen.container.textContent).toContain('Step 3');
				await expect.poll(() => screen.container.textContent).toContain('Watch live');
				await shoot(`rows-open-${vp.name}-${t}`, screen.container.firstElementChild!, vp.width);
			});
		}
	}

	for (const t of ['light', 'dark'] as const) {
		for (const status of ['completed', 'running'] as const) {
			it(`transcript-${status}-${t}`, async () => {
				vi.stubGlobal(
					'fetch',
					vi.fn(async () => new Response('{}', { status: 500 }))
				);
				await theme(t);
				await browserPage.viewport(1280, 800);
				const msg = (id: string, role: string, parts: unknown[], at: number) => ({
					id,
					conversationId: 'sub-1',
					role,
					parts,
					status: 'complete',
					error: null,
					usage: null,
					createdAt: at
				});
				const messages = [
					msg('m1', 'user', [{ type: 'text', text: input.prompt }], NOW - 83_000),
					msg(
						'm2',
						'assistant',
						[
							{
								type: 'dynamic-tool',
								toolName: 'fetch',
								toolCallId: 't1',
								state: 'output-available',
								input: { url: 'https://github.com/pgvector/pgvector' },
								output: { content: [{ type: 'text', text: '# pgvector\n…' }] }
							},
							{
								type: 'dynamic-tool',
								toolName: 'fetch',
								toolCallId: 't2',
								state: 'output-available',
								input: { url: 'https://qdrant.tech/documentation/concepts/filtering/' },
								output: { content: [{ type: 'text', text: '# Filtering\n…' }] }
							},
							...(status === 'completed' ? [{ type: 'text', text: REPORT }] : [])
						],
						NOW - 60_000
					)
				];
				const screen = render(TranscriptPage, {
					data: {
						subagent: {
							id: 'sub-1',
							description: input.description,
							parentId: 'chat-1',
							parentTitle: 'Research chat',
							parentIsChat: true,
							status,
							startedAt: NOW - 83_000,
							endedAt: status === 'completed' ? NOW : null,
							error: null,
							progress: null
						},
						messages,
						timeFormat: 'auto'
					} as never
				});
				const root = document.createElement('div');
				root.style.cssText = 'height:800px;display:flex;flex-direction:column';
				screen.container.parentElement!.insertBefore(root, screen.container);
				root.appendChild(screen.container);
				screen.container.style.cssText = 'display:flex;flex:1;min-height:0;flex-direction:column';
				await expect.poll(() => screen.container.textContent).toContain(input.description);
				await shoot(`transcript-${status}-${t}`, root, 1280);
			});
		}
	}
});
