import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import '../../../../routes/layout.css';

const { invalidateAll } = vi.hoisted(() => ({ invalidateAll: vi.fn() }));
vi.mock('$app/navigation', () => ({
	goto: vi.fn(),
	invalidate: vi.fn(),
	invalidateAll,
	afterNavigate: vi.fn(),
	beforeNavigate: vi.fn(),
	onNavigate: vi.fn()
}));

const { default: ProviderTrustBanner } = await import('./ProviderTrustBanner.svelte');

const KEY = 'chatty.providers.trustBannerDismissed';

const provider = (id: string, name: string, baseUrl: string | null, allowPrivate = false) => ({
	id,
	name,
	type: 'openai-compatible',
	baseUrl,
	allowPrivate
});

const providers = [
	provider('lm', 'Desk LM Studio', 'http://192.168.1.5:1234/v1'),
	provider('ol', 'Ollama', 'http://localhost:11434/v1', true),
	provider('oa', 'OpenAI', 'https://api.openai.com/v1')
];

beforeEach(() => localStorage.removeItem(KEY));
afterEach(() => {
	vi.unstubAllGlobals();
	invalidateAll.mockReset();
});

describe('ProviderTrustBanner', () => {
	it('asks only about local servers that are not trusted yet', async () => {
		render(ProviderTrustBanner, { providers });
		await expect
			.element(page.getByText('Allow Desk LM Studio to process private data?'))
			.toBeInTheDocument();
		expect(document.body.textContent).not.toContain('Allow Ollama');
		expect(document.body.textContent).not.toContain('Allow OpenAI');
	});

	it('remembers a dismissal', async () => {
		const first = render(ProviderTrustBanner, { providers });
		await page.getByRole('button', { name: 'Dismiss' }).click();
		await expect
			.element(page.getByText('Allow Desk LM Studio', { exact: false }))
			.not.toBeInTheDocument();
		expect(JSON.parse(localStorage.getItem(KEY) ?? '[]')).toEqual(['lm']);
		first.unmount();
		render(ProviderTrustBanner, { providers });
		await new Promise((r) => setTimeout(r, 50));
		expect(document.body.textContent).not.toContain('Allow Desk LM Studio');
	});

	it('trusts the provider on Allow', async () => {
		const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);
		render(ProviderTrustBanner, { providers });
		await page.getByRole('button', { name: 'Allow' }).click();
		await vi.waitFor(() => expect(invalidateAll).toHaveBeenCalled());
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('/api/providers/lm');
		expect(init.method).toBe('PATCH');
		expect(JSON.parse(String(init.body))).toEqual({ allowPrivate: true });
	});
});
