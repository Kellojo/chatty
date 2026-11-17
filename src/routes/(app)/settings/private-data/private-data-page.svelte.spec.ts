import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import '../../../layout.css';
import { visibleSettingsSections } from '$lib/settings-sections.js';

const { invalidateAll } = vi.hoisted(() => ({ invalidateAll: vi.fn() }));
vi.mock('$app/state', () => ({
	page: { params: {}, url: new URL('http://localhost/settings/private-data'), data: {} },
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

const { default: PrivateDataSettings } = await import('./+page.svelte');

function renderPage(patch: Record<string, unknown> = {}) {
	return render(PrivateDataSettings, {
		data: {
			isAdmin: false,
			privateDataEnabled: true,
			privateByDefault: false,
			trustedProviders: ['LM Studio'],
			...patch
		} as never
	});
}

afterEach(() => vi.unstubAllGlobals());

describe('Settings → Private data', () => {
	it('saves New chats are private', async () => {
		const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);
		renderPage();
		await page.getByRole('switch', { name: 'New chats are private' }).click();
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('/api/user/settings');
		expect(JSON.parse(String(init.body))).toEqual({ privateByDefault: true });
	});

	it('shows the instance switch to admins only', async () => {
		const user = renderPage();
		await expect.element(page.getByText('New chats are private')).toBeInTheDocument();
		expect(document.body.textContent).not.toContain('Allow private data');
		user.unmount();
		renderPage({ isAdmin: true });
		await expect.element(page.getByText('Allow private data')).toBeInTheDocument();
	});

	it('only shows the instance switch while private data is off', async () => {
		renderPage({ isAdmin: true, privateDataEnabled: false });
		await expect.element(page.getByText('Allow private data')).toBeInTheDocument();
		expect(document.body.textContent).not.toContain('New chats are private');
	});

	it('is listed for admins always, for others once private data is on', () => {
		const listed = (isAdmin: boolean, on: boolean) =>
			visibleSettingsSections(isAdmin, on).some((s) => s.href === '/settings/private-data');
		expect(listed(true, false)).toBe(true);
		expect(listed(false, false)).toBe(false);
		expect(listed(false, true)).toBe(true);
	});
});
