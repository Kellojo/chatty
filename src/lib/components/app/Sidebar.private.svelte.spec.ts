import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page as browserPage } from 'vitest/browser';
import '../../../routes/layout.css';
import type { Conversation, PrivateDataStatus } from '$lib/types.js';

const state = vi.hoisted(() => ({
	privateData: {
		enabled: true,
		available: true,
		sttTrusted: false,
		ttsTrusted: false
	} as PrivateDataStatus
}));
vi.mock('$app/state', () => ({
	page: {
		params: { id: 'current' },
		url: new URL('http://localhost/chat/current'),
		get data() {
			return { privateData: state.privateData };
		}
	},
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

const now = Date.now();
function conv(id: string, title: string, patch: Partial<Conversation> = {}): Conversation {
	return {
		id,
		kind: 'chat',
		origin: 'user',
		agentRun: null,
		title,
		providerId: 'p',
		modelId: 'm',
		systemPrompt: null,
		memoryEnabled: false,
		maxSteps: null,
		temperature: null,
		maxTokens: null,
		pinned: false,
		private: false,
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

const conversations = [
	conv('a', 'Tax return'),
	conv('b', 'Doctor visit'),
	conv('locked', 'Already locked', { private: true }),
	conv('task', 'Refactor scheduler', {
		coding: {
			projectTitle: 'ai-chat',
			status: 'idle',
			runStartedAt: null,
			diff: null,
			pullRequest: null
		}
	})
];

function renderSidebar() {
	return render(Sidebar, {
		user: { name: 'Ada', email: 'ada@example.com', image: null, role: 'user' },
		conversations,
		hasMore: false,
		unreadIds: [],
		settledCount: 0,
		autoSettleDays: 14,
		onclose: () => {},
		onshowshortcuts: () => {}
	});
}

const json = (body: unknown) =>
	new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

afterEach(() => {
	vi.unstubAllGlobals();
	state.privateData = { ...state.privateData, enabled: true, available: true };
});

/** Opens a row's "More actions" menu. */
async function openRowMenu(id: string) {
	const row = document.querySelector(`a[data-conversation-id="${id}"]`)!.parentElement!;
	(row.querySelector('button[aria-label="More actions"]') as HTMLButtonElement).click();
	await expect.element(browserPage.getByRole('menuitem', { name: 'Rename' })).toBeInTheDocument();
}

describe('Sidebar multi-select → Make private', () => {
	it('picks chats and makes the eligible ones private in one go', async () => {
		const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
			if (url.endsWith('/derived-concepts')) return json({ concepts: [] });
			if (url === '/api/conversations/private' && init?.method === 'POST') {
				return json({ updated: ['a', 'b'], skipped: [] });
			}
			return new Response('{}', { status: 404 });
		});
		vi.stubGlobal('fetch', fetchMock);
		renderSidebar();
		await openRowMenu('a');
		await browserPage.getByRole('menuitem', { name: 'Select…' }).click();

		await expect.element(browserPage.getByText('1 selected')).toBeInTheDocument();
		await expect
			.element(browserPage.getByRole('checkbox', { name: 'Select Tax return' }))
			.toBeChecked();
		// Coding tasks and private chats can be picked for the other bulk actions,
		// but Make private leaves them out.
		await browserPage.getByRole('checkbox', { name: 'Select Refactor scheduler' }).click();
		await browserPage.getByRole('checkbox', { name: 'Select Already locked' }).click();
		await expect.element(browserPage.getByText('3 selected')).toBeInTheDocument();
		// While picking, a click on a row picks it instead of opening it.
		const link = document.querySelector('a[data-conversation-id="b"]') as HTMLAnchorElement;
		// Seen after the app's own (delegated) handler.
		const prevented = vi.fn((e: MouseEvent) => e.defaultPrevented);
		document.addEventListener('click', prevented, { once: true });
		link.click();
		await expect.element(browserPage.getByText('4 selected')).toBeInTheDocument();
		expect(prevented).toHaveReturnedWith(true);

		await browserPage.getByRole('button', { name: 'Make selected private' }).click();
		await expect.element(browserPage.getByText('Make 2 chats private?')).toBeInTheDocument();
		await browserPage.getByRole('button', { name: 'Make private', exact: true }).click();
		await vi.waitFor(() =>
			expect(fetchMock.mock.calls.some(([url]) => url === '/api/conversations/private')).toBe(true)
		);
		const call = fetchMock.mock.calls.find(([url]) => url === '/api/conversations/private')!;
		expect(JSON.parse(String(call[1]!.body))).toEqual({ ids: ['a', 'b'] });
		// Done: the selection ends.
		await expect
			.element(browserPage.getByRole('toolbar', { name: 'Selected chats' }))
			.not.toBeInTheDocument();
	});

	it('offers no Make private action without a trusted provider', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('{}', { status: 404 }))
		);
		state.privateData = { ...state.privateData, available: false };
		renderSidebar();
		await openRowMenu('a');
		await browserPage.getByRole('menuitem', { name: 'Select…' }).click();
		await expect.element(browserPage.getByText('1 selected')).toBeInTheDocument();
		await expect
			.element(browserPage.getByRole('button', { name: 'Make selected private' }))
			.not.toBeInTheDocument();
		await expect
			.element(browserPage.getByRole('button', { name: 'Settle selected' }))
			.toBeInTheDocument();
	});
});
