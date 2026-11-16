import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import '../../../layout.css';
import { DEFAULT_USER_SETTINGS } from '$lib/user-settings.js';
import type { PrivateDataStatus } from '$lib/types.js';

const { invalidateAll } = vi.hoisted(() => ({ invalidateAll: vi.fn() }));
vi.mock('$app/state', () => ({
	page: { params: {}, url: new URL('http://localhost/settings/conversation'), data: {} },
	navigating: { to: null },
	updated: { current: false }
}));
vi.mock('$app/navigation', () => ({
	goto: vi.fn(),
	invalidate: vi.fn(),
	invalidateAll,
	afterNavigate: vi.fn(),
	beforeNavigate: vi.fn(),
	onNavigate: vi.fn()
}));

const { default: ConversationSettings } = await import('./+page.svelte');

const status = (patch: Partial<PrivateDataStatus> = {}): PrivateDataStatus => ({
	enabled: true,
	available: true,
	sttTrusted: false,
	ttsTrusted: false,
	...patch
});

function renderPage(privateData: PrivateDataStatus) {
	return render(ConversationSettings, {
		// Only what the page reads.
		data: { settings: DEFAULT_USER_SETTINGS, serverTts: false, privateData } as never
	});
}

afterEach(() => vi.unstubAllGlobals());

describe('Settings → Conversation: New chats are private', () => {
	it('saves the setting', async () => {
		const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);
		renderPage(status());
		await page.getByRole('switch', { name: 'New chats are private' }).click();
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('/api/user/settings');
		expect(JSON.parse(String(init.body))).toEqual({ privateByDefault: true });
	});

	it('is hidden while private data is off', async () => {
		renderPage(status({ enabled: false }));
		await expect.element(page.getByText('Response instructions')).toBeInTheDocument();
		expect(document.body.textContent).not.toContain('New chats are private');
	});
});
