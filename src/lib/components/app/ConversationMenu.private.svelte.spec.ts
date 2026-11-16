import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import '../../../routes/layout.css';
import type { Conversation, PrivateDataStatus } from '$lib/types.js';

vi.mock('$app/state', () => ({
	page: {
		params: { id: 'c1' },
		url: new URL('http://localhost/chat/c1'),
		data: { user: { role: 'admin' }, unreadIds: [] }
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

const { default: ConversationMenu } = await import('./ConversationMenu.svelte');

afterEach(() => {
	vi.unstubAllGlobals();
});

const conv = (patch: Partial<Conversation> = {}): Conversation => ({
	id: 'c1',
	kind: 'chat',
	origin: 'user',
	agentRun: null,
	title: 'Tax questions',
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
	createdAt: 0,
	updatedAt: 0,
	...patch
});

const status = (patch: Partial<PrivateDataStatus> = {}): PrivateDataStatus => ({
	enabled: true,
	available: true,
	sttTrusted: false,
	ttsTrusted: false,
	...patch
});

async function openMenu() {
	await page.getByRole('button', { name: 'Conversation actions' }).click();
	await expect.element(page.getByRole('menuitem', { name: 'Rename' })).toBeInTheDocument();
}

describe('ConversationMenu privacy items', () => {
	it('offers Make private for a public chat', async () => {
		render(ConversationMenu, {
			conversation: conv(),
			privateData: status(),
			onupdated: () => {}
		});
		await openMenu();
		await expect.element(page.getByRole('menuitem', { name: 'Make private' })).toBeInTheDocument();
	});

	it('hides the privacy items while the feature is off', async () => {
		render(ConversationMenu, {
			conversation: conv(),
			privateData: status({ enabled: false }),
			onupdated: () => {}
		});
		await openMenu();
		expect(document.body.textContent).not.toContain('Make private');
	});

	it('hides the privacy items on coding chats', async () => {
		render(ConversationMenu, {
			conversation: conv({
				coding: {
					projectTitle: 'ai-chat',
					status: 'idle',
					runStartedAt: null,
					diff: null,
					pullRequest: null
				}
			}),
			privateData: status(),
			onupdated: () => {}
		});
		await openMenu();
		expect(document.body.textContent).not.toContain('Make private');
	});

	it('points to Settings when no provider is trusted yet', async () => {
		render(ConversationMenu, {
			conversation: conv(),
			privateData: status({ available: false }),
			onupdated: () => {}
		});
		await openMenu();
		await expect
			.element(page.getByText('Trust a provider in Settings → Providers first'))
			.toBeInTheDocument();
	});

	it('asks before making a private chat public', async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ conversation: conv({ private: false }) }), {
					headers: { 'content-type': 'application/json' }
				})
		);
		vi.stubGlobal('fetch', fetchMock);
		const onupdated = vi.fn();
		render(ConversationMenu, {
			conversation: conv({ private: true }),
			privateData: status(),
			onupdated
		});
		await openMenu();
		await page.getByRole('menuitem', { name: 'Make public…' }).click();
		await expect
			.element(
				page.getByText("Anything already sent in this chat can't be recalled", { exact: false })
			)
			.toBeInTheDocument();
		expect(fetchMock).not.toHaveBeenCalled();
		await page.getByRole('button', { name: 'Make public', exact: true }).click();
		await vi.waitFor(() => expect(onupdated).toHaveBeenCalled());
		const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(JSON.parse(String(init.body))).toEqual({ private: false, confirm: true });
	});
});
