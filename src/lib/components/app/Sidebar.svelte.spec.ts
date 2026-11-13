import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page as browserPage } from 'vitest/browser';
import '../../../routes/layout.css';
import type { Conversation } from '$lib/types.js';
import type { CodingConversationSummary } from '$lib/coding-environments.js';

vi.mock('$app/state', () => ({
	page: { params: { id: 'current' }, url: new URL('http://localhost/chat/current') },
	navigating: { to: null },
	updated: { current: false }
}));
vi.mock('$app/navigation', () => ({
	goto: vi.fn(),
	invalidate: vi.fn(),
	invalidateAll: vi.fn(),
	afterNavigate: vi.fn(),
	beforeNavigate: vi.fn(),
	onNavigate: vi.fn()
}));

const { default: Sidebar } = await import('./Sidebar.svelte');
const { serverActiveChats } = await import('$lib/state/chat-status.svelte.js');

const now = Date.now();
const coding = (patch: Partial<CodingConversationSummary>): CodingConversationSummary => ({
	projectTitle: 'ai-chat',
	status: 'idle',
	runStartedAt: null,
	diff: null,
	pullRequest: null,
	...patch
});
function conv(id: string, title: string, patch: Partial<Conversation> = {}): Conversation {
	return {
		id,
		kind: 'chat',
		origin: 'user',
		agentRun: null,
		title,
		mode: 'chat',
		providerId: 'p',
		modelId: 'anthropic/claude-opus-5-5',
		systemPrompt: null,
		memoryEnabled: false,
		maxSteps: null,
		temperature: null,
		maxTokens: null,
		pinned: false,
		agentId: null,
		settledAt: null,
		settledReason: null,
		snoozedUntil: null,
		wokeAt: null,
		coding: null,
		createdAt: now,
		updatedAt: now,
		...patch
	};
}

const conversations: Conversation[] = [
	conv('working-chat', 'Plan the Q3 roadmap'),
	conv('working-task', 'Sidebar status polish', {
		coding: coding({ status: 'running', runStartedAt: now - 97_000 })
	}),
	conv('needs-you', 'Migrate auth to passkeys', {
		coding: coding({ status: 'awaiting_input' })
	}),
	conv('agent-asks', 'Weekly inbox triage', {
		origin: 'dispatch',
		agentId: 'triage',
		agentRun: { id: 'run-1', status: 'awaiting_input' }
	}),
	conv('failed', 'Fix flaky e2e suite', { coding: coding({ status: 'failed' }) }),
	conv('unread-chat', 'Recipe ideas for the weekend'),
	conv('unread-task', 'Add dark mode toggle', {
		coding: coding({ pullRequest: { state: 'open' } })
	}),
	conv('current', 'The chat I have open'),
	conv('read-chat', 'Explain vector clocks'),
	conv('read-task', 'Refactor scheduler', {
		coding: coding({ pullRequest: { state: 'merged' } })
	}),
	conv('stopped', 'Bump dependencies', { coding: coding({ status: 'interrupted' }) }),
	conv('read-old', 'Trip packing list', { updatedAt: now - 3 * 86_400_000 })
];

const unreadIds = ['failed', 'unread-chat', 'unread-task'];

const SHOTS = import.meta.env.VITE_SIDEBAR_SHOTS as string | undefined;

describe('Sidebar row states', () => {
	afterEach(() => {
		serverActiveChats.clear();
		document.documentElement.classList.remove('dark');
	});

	it('shows a task blocked on a question as needing you, though its stream is open', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('{}', { status: 404 }))
		);
		// The agent's run is still active while it waits, so the server reports a live stream.
		serverActiveChats.set('needs-you', now - 5_000);
		const screen = render(Sidebar, {
			user: { name: 'Ada Lovelace', email: 'ada@example.com', image: null, role: 'user' },
			conversations,
			hasMore: false,
			unreadIds,
			settledCount: 0,
			autoSettleDays: 14,
			onclose: () => {},
			onshowshortcuts: () => {}
		});
		const row = screen.container.querySelector('[data-conversation-id="needs-you"]');
		expect(row?.getAttribute('title')).toContain('Needs you');
		vi.unstubAllGlobals();
	});

	it('shows an agent run waiting on a question as needing you', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('{}', { status: 404 }))
		);
		// The run's turn ended with the question, so no stream is open.
		const screen = render(Sidebar, {
			user: { name: 'Ada Lovelace', email: 'ada@example.com', image: null, role: 'user' },
			conversations,
			hasMore: false,
			unreadIds,
			settledCount: 0,
			autoSettleDays: 14,
			onclose: () => {},
			onshowshortcuts: () => {}
		});
		const row = screen.container.querySelector('[data-conversation-id="agent-asks"]');
		expect(row?.getAttribute('title')).toContain('Needs you');
		expect(row?.textContent).toContain('Agent chat:');
		vi.unstubAllGlobals();
	});

	const touch = matchMedia('(pointer: coarse)').matches;
	for (const viewport of [
		{ name: 'desktop', width: 1000, height: 820 },
		{ name: 'mobile', width: 390, height: 820 }
	].filter((v) => !SHOTS || (v.name === 'mobile') === touch)) {
		for (const theme of ['light', 'dark'] as const) {
			it(`renders every state (${viewport.name}, ${theme})`, async () => {
				vi.stubGlobal(
					'fetch',
					vi.fn(async () => new Response('{}', { status: 404 }))
				);
				await browserPage.viewport(viewport.width, viewport.height);
				if (theme === 'dark') document.documentElement.classList.add('dark');
				document.body.className = 'bg-background text-foreground';
				serverActiveChats.set('working-chat', now - 12_000);
				const screen = render(Sidebar, {
					user: { name: 'Ada Lovelace', email: 'ada@example.com', image: null, role: 'user' },
					conversations,
					hasMore: false,
					unreadIds,
					settledCount: 0,
					autoSettleDays: 14,
					onclose: () => {},
					onshowshortcuts: () => {}
				});
				// The app gives the sidebar the full width on phones and the window's height.
				screen.container.style.height = `${viewport.height}px`;
				if (viewport.name === 'mobile') screen.container.classList.add('[&>aside]:w-full');
				const nav = screen.container.querySelector('nav');
				expect(nav).not.toBeNull();
				await new Promise((r) => setTimeout(r, 400));
				if (SHOTS) {
					// The runner scales its iframe down to fit; undo that for full-size captures.
					const host = window.frameElement?.parentElement;
					if (host) {
						host.style.transform = 'none';
						host.setAttribute('data-scale', '1');
					}
					await browserPage.screenshot({
						path: `${SHOTS}/${viewport.name}-${theme}.png`,
						scale: 'css',
						element: screen.container.querySelector('aside') as HTMLElement
					});
				}
				vi.unstubAllGlobals();
			});
		}
	}
});

describe('Sidebar paging', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('keeps rows paged in by scrolling when the first page is refreshed', async () => {
		const base = [conv('a', 'First'), conv('b', 'Second')];
		const older = [
			conv('c', 'Third', { updatedAt: now - 30 * 86_400_000 }),
			conv('d', 'Fourth', { updatedAt: now - 31 * 86_400_000 })
		];
		const requests: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (!url.startsWith('/api/conversations?')) return new Response('{}', { status: 404 });
				requests.push(url);
				// The refetched range shows a row renamed since it was first paged in.
				const rows = url.includes('limit=')
					? [older[0], { ...older[1], title: 'Fourth, renamed' }]
					: older;
				return new Response(JSON.stringify({ conversations: rows, hasMore: false }));
			})
		);
		const props = {
			user: { name: 'Ada Lovelace', email: 'ada@example.com', image: null, role: 'user' },
			conversations: base,
			hasMore: true,
			unreadIds: [],
			settledCount: 0,
			autoSettleDays: 14,
			onclose: () => {},
			onshowshortcuts: () => {}
		};
		const screen = render(Sidebar, props);
		const row = (id: string) => screen.container.querySelector(`[data-conversation-id="${id}"]`);
		await vi.waitFor(() => expect(row('d')).not.toBeNull());
		expect(requests).toEqual(['/api/conversations?offset=2']);

		// A sidebar refresh: same first page, new array.
		await screen.rerender({ ...props, conversations: base.map((c) => ({ ...c })) });
		expect(row('c')).not.toBeNull();
		await vi.waitFor(() => expect(row('d')?.textContent).toContain('Fourth, renamed'));
		expect(requests).toEqual([
			'/api/conversations?offset=2',
			'/api/conversations?offset=2&limit=2'
		]);
	});
});
