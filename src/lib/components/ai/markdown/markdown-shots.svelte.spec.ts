import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page as browserPage } from 'vitest/browser';
import { setMode } from 'mode-watcher';
import '../../../../routes/layout.css';
import Markdown from './markdown.svelte';

/**
 * Screenshots of every markdown feature and chat widget, rendered through the
 * real Markdown component at chat width:
 * `VITE_MARKDOWN_SHOTS=<dir> pnpm test:unit -- --run markdown-shots`.
 */
const SHOTS = import.meta.env.VITE_MARKDOWN_SHOTS as string | undefined;

const fence = (lang: string, value: unknown) =>
	'```' + lang + '\n' + JSON.stringify(value, null, 2) + '\n```';

const TABLES = [
	'Short table with right-aligned numbers:',
	'',
	'| Tool | Server | Calls | Avg. latency |',
	'| --- | --- | ---: | ---: |',
	'| fs_read | fs | 128 | 12 ms |',
	'| fetch | webfetch | 41 | 830 ms |',
	'| get_weather | weather | 9 | 410 ms |',
	'',
	'A comparison with prose cells, inline code, links and centered column:',
	'',
	'| Option | Pros | Cons | Effort | Recommended |',
	'| --- | --- | --- | :---: | :---: |',
	'| **SQLite** | Zero ops, a single file, fast reads, easy to back up with `sqlite3 .backup` | Single writer; harder to scale horizontally across many machines | Low | ✅ |',
	'| Postgres | Rich types, [extensions](https://example.com), concurrent writes | Needs a server, migrations and connection pooling | Medium | — |',
	'| DynamoDB | Fully managed, scales without thinking about it | Vendor lock-in; awkward queries and `GSI` design | High | ❌ |',
	'',
	'A wide table with many columns:',
	'',
	'| Model | Provider | Context | Input $/M | Output $/M | Tokens/s | Latency | Vision | Tools | Score |',
	'| --- | --- | ---: | ---: | ---: | ---: | ---: | :---: | :---: | ---: |',
	'| claude-opus-5-5 | Anthropic | 1,000,000 | 15.00 | 75.00 | 62 | 1.9 s | yes | yes | 92.4 |',
	'| gpt-5.5 | OpenAI | 400,000 | 10.00 | 40.00 | 88 | 1.2 s | yes | yes | 90.1 |',
	'| qwen3-coder-30b | Local | 131,072 | 0.00 | 0.00 | 41 | 0.4 s | no | yes | 71.8 |',
	'',
	'| Key | Value |',
	'| --- | --- |',
	'| Empty cell |  |',
	'| A very long unbroken token | `sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` |'
].join('\n');

const BASICS = [
	'# Heading 1',
	'A paragraph with **bold**, _italic_, `inline code`, ~~strikethrough~~ and a [link](https://example.com). Long paragraphs need comfortable line length and leading — this sentence is intentionally long to check wrapping across the chat column.',
	'## Heading 2',
	'Some text under heading 2.',
	'### Heading 3',
	'#### Heading 4',
	'- Unordered item',
	'- Item with nested list',
	'  - Nested item one',
	'  - Nested item two',
	'    - Third level',
	'',
	'1. Ordered item',
	'2. Second ordered item',
	'   1. Nested ordered',
	'10. Tenth item (wide marker)',
	'',
	'- [x] Finished task',
	'- [ ] Open task',
	'',
	'> A blockquote that spans a sentence or two, used for callouts and quoted sources.',
	'>',
	'> A second paragraph in the quote with `code`.',
	'',
	'Footnote-ish text and a line break  ',
	'right here.',
	'',
	'---',
	'',
	'A final line after a horizontal rule.'
].join('\n');

const CODE = [
	'Inline math $$E = mc^2$$ and a block:',
	'',
	'$$',
	'\\int_0^1 x^2 \\, dx = \\frac{1}{3}',
	'$$',
	'',
	'```ts',
	'export function greet(name: string): string {',
	'\treturn `Hello, ${name}!`;',
	'}',
	'```',
	'',
	'```',
	'plain block without a language, with a very long line that should scroll sideways rather than wrap or overflow the card ......................................',
	'```',
	'',
	'```mermaid',
	'flowchart LR',
	'  User --> Chat --> Tools',
	'  Tools --> Chat',
	'```'
].join('\n');

const WEATHER = {
	location: { name: 'Lisbon', country: 'Portugal', admin1: 'Lisbon', timezone: 'Europe/Lisbon' },
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

const WIDGETS_A = [
	fence('weather', WEATHER),
	fence('chart', {
		type: 'bar',
		title: 'Tool calls per day',
		labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
		datasets: [
			{ label: 'fs', data: [12, 19, 8, 15, 22] },
			{ label: 'webfetch', data: [5, 9, 4, 11, 7] }
		]
	}),
	fence('chart', {
		type: 'line',
		title: 'Latency (ms)',
		labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
		datasets: [{ label: 'p50', data: [320, 280, 410, 300, 260] }]
	}),
	fence('chart', {
		type: 'pie',
		title: 'Share by server',
		labels: ['fs', 'webfetch', 'math'],
		datasets: [{ data: [55, 30, 15] }]
	})
].join('\n\n');

const WIDGETS_B = [
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
			{ name: 'Fábrica Coffee Roasters', lat: 38.7163, lng: -9.1428, notes: 'Great flat white' }
		]
	}),
	fence('file', { name: 'report.html', path: 'report.html' }),
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
			}
		]
	}),
	fence('links', {
		links: [
			{
				url: 'https://developer.mozilla.org/en-US/docs/Web/CSS',
				title: 'CSS container queries - CSS: Cascading Style Sheets | MDN',
				site: 'MDN Web Docs',
				description:
					'Cascading Style Sheets is a stylesheet language used to describe presentation.'
			},
			{ url: 'https://www.example.com/post', title: 'Example post' }
		]
	})
].join('\n\n');

const WIDGETS_C = [
	fence('clock', {
		at: '2026-11-09T23:00:00Z',
		convert: true,
		zones: [
			{ label: 'Los Angeles', tz: 'America/Los_Angeles' },
			{ label: 'Berlin', tz: 'Europe/Berlin' },
			{ label: 'Kolkata', tz: 'Asia/Kolkata' }
		]
	}),
	fence('calc', { kind: 'calculate', expression: '1000 * 3 - 1', result: 2999 }),
	fence('calc', {
		kind: 'convert',
		measure: 'length',
		from: { value: 12.4, unit: 'km', name: 'kilometers' },
		to: [
			{ value: 7.70505181, unit: 'mi', name: 'miles' },
			{ value: 12400, unit: 'm', name: 'meters' }
		]
	}),
	fence('calc', {
		kind: 'statistics',
		count: 4,
		sum: 10,
		mean: 2.5,
		median: 2.5,
		q1: 1.75,
		q3: 3.25,
		min: 1,
		max: 4,
		variance: 1.25,
		stdev: 1.118033988,
		sample: false,
		values: [1, 2, 3, 4]
	}),
	fence('memory', {
		items: [
			{
				action: 'created',
				path: 'people/maria.md',
				scope: 'user',
				title: 'Maria Lopez',
				snippet: 'Your sister; lives in Valencia.'
			},
			{ action: 'updated', path: 'preferences/coffee.md', title: 'Coffee order' },
			{ action: 'deleted', path: 'projects/old-site.md', scope: 'shared' }
		]
	})
].join('\n\n');

const WIDGETS_D = [
	fence('agent', {
		id: 'a1',
		name: 'morning-briefing',
		description: 'Summarises the morning.',
		modelName: 'Claude Sonnet 4.5',
		modelId: 'claude-sonnet-4-5',
		skillNames: ['briefing'],
		toolAllowlist: [
			'search_chats',
			'read_chat',
			'get_weather',
			'search_memory',
			'fetch_url',
			'web_search',
			'x__list_issues'
		],
		triggerType: 'schedule',
		triggerConfig: { cron: '0 9 * * 1-5' },
		codingTarget: null,
		enabled: true,
		nextRunAt: null
	}),
	fence('mealplan', {
		title: 'This week',
		from: '2026-11-09',
		to: '2026-11-15',
		items: [
			{
				date: '2026-11-09',
				slot: 'Dinner',
				recipeName: 'Butter Chicken',
				servings: 4,
				calories: 700
			},
			{ date: '2026-11-10', slot: 'Lunch', name: 'Bauernsalat', calories: 410 },
			{
				date: '2026-11-12',
				slot: 'Breakfast',
				name: 'Overnight oats with berries and a long name',
				calories: 350
			}
		]
	}),
	fence('events', {
		title: 'Concerts in Berlin',
		events: [
			{ title: 'Jazz Brunch', start: '2026-11-08T11:00', price: '€18' },
			{
				title: 'Moderat',
				start: '2026-11-16T20:00',
				venue: 'Columbiahalle',
				city: 'Berlin',
				status: 'few',
				price: '€45',
				url: 'https://example.com/moderat'
			},
			{ title: 'Jazzfest', start: '2026-11-20', end: '2026-11-22' }
		]
	})
].join('\n\n');

const STATES = [
	'Broken payload:',
	'',
	'```chart\nnot json',
	'```',
	'',
	'Loading (the fence is still streaming):',
	'',
	'```weather\n{"location":'
].join('\n');

const SECTIONS: Record<string, string> = {
	tables: TABLES,
	basics: BASICS,
	code: CODE,
	'widgets-a': WIDGETS_A,
	'widgets-b': WIDGETS_B,
	'widgets-c': WIDGETS_C,
	'widgets-d': WIDGETS_D,
	states: STATES
};

afterEach(() => {
	document.documentElement.classList.remove('dark');
	setMode('light');
	for (const column of document.querySelectorAll('[data-shot-column]')) column.remove();
});

async function shoot(name: string, el: HTMLElement, width: number) {
	const frame = window.frameElement as HTMLElement | null;
	const host = frame?.parentElement;
	if (host) {
		host.style.transform = 'none';
		host.setAttribute('data-scale', '1');
	}
	if (frame) {
		frame.style.cssText = `position:fixed;top:0;left:0;z-index:2147483647;width:${width}px;height:4000px;border:0;`;
	}
	await new Promise((r) => setTimeout(r, 1500));
	await browserPage.screenshot({ path: `${SHOTS}/${name}.png`, scale: 'css', element: el });
}

const which = (import.meta.env.VITE_MARKDOWN_SHOTS_ONLY as string | undefined)?.split(',');

describe.skipIf(!SHOTS)('Markdown screenshots', () => {
	const viewports = [
		{ name: 'desktop', width: 900 },
		{ name: 'mobile', width: 390 }
	];
	for (const [section, content] of Object.entries(SECTIONS)) {
		for (const vp of viewports) {
			for (const theme of ['light', 'dark'] as const) {
				const name = `${section}-${vp.name}-${theme}`;
				if (which && !which.some((w) => name.includes(w))) continue;
				it(name, async () => {
					if (theme === 'dark') {
						document.documentElement.classList.add('dark');
						setMode('dark');
					}
					document.body.style.margin = '0';
					document.body.style.background = 'var(--background)';
					await browserPage.viewport(vp.width, 4000);
					// Same column as MessageTimeline: max-w-3xl, px-4.
					const screen = render(Markdown, {
						content,
						streaming: section === 'states',
						class: 'w-full max-w-none',
						conversationId: 'conv-shots'
					});
					const column = document.createElement('div');
					column.dataset.shotColumn = '';
					column.className = 'mx-auto w-full max-w-3xl bg-background px-4 py-6 text-foreground';
					screen.container.parentElement!.insertBefore(column, screen.container);
					column.appendChild(screen.container);
					await expect.poll(() => screen.container.textContent?.length ?? 0).toBeGreaterThan(0);
					await shoot(name, column, vp.width);
				});
			}
		}
	}

	// Full-viewport overlays: a table's fullscreen view and an expanded mermaid diagram.
	const overlays = [
		{
			name: 'table-fullscreen',
			content: TABLES,
			button: '[data-streamdown="table-toolbar"] button[title="View fullscreen"]'
		},
		{
			name: 'mermaid-expanded',
			content: CODE,
			button: '[data-expanded] button[title="View fullscreen"]'
		}
	];
	for (const overlay of overlays) {
		for (const theme of ['light', 'dark'] as const) {
			const name = `${overlay.name}-${theme}`;
			if (which && !which.some((w) => name.includes(w))) continue;
			it(name, async () => {
				if (theme === 'dark') {
					document.documentElement.classList.add('dark');
					setMode('dark');
				}
				document.body.style.margin = '0';
				document.body.style.background = 'var(--background)';
				const frame = window.frameElement as HTMLElement | null;
				const host = frame?.parentElement;
				if (host) {
					host.style.transform = 'none';
					host.setAttribute('data-scale', '1');
				}
				if (frame) {
					frame.style.cssText =
						'position:fixed;top:0;left:0;z-index:2147483647;width:1280px;height:800px;border:0;';
				}
				await browserPage.viewport(1280, 800);
				const screen = render(Markdown, { content: overlay.content, streaming: false });
				await expect
					.poll(
						() =>
							screen.container.querySelector<HTMLButtonElement>(overlay.button)?.disabled === false
					)
					.toBe(true);
				await new Promise((r) => setTimeout(r, 800));
				screen.container.querySelector<HTMLButtonElement>(overlay.button)!.click();
				await new Promise((r) => setTimeout(r, 1200));
				await browserPage.screenshot({ path: `${SHOTS}/${name}.png`, scale: 'css' });
			});
		}
	}
});
