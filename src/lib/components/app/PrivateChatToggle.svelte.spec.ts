import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import '../../../routes/layout.css';
import PrivateChatToggle from './PrivateChatToggle.svelte';
import type { PrivateDataStatus } from '$lib/types.js';

const status = (patch: Partial<PrivateDataStatus>): PrivateDataStatus => ({
	enabled: true,
	available: true,
	sttTrusted: false,
	ttsTrusted: false,
	...patch
});

describe('PrivateChatToggle', () => {
	it('renders nothing while the private-data feature is off', () => {
		const screen = render(PrivateChatToggle, { status: status({ enabled: false }) });
		expect(screen.container.querySelector('button')).toBeNull();
	});

	it('is disabled with a pointer to Settings when no provider is trusted', async () => {
		render(PrivateChatToggle, { status: status({ available: false }), admin: true });
		const lock = page.getByRole('button', { name: 'Private chat' });
		await expect.element(lock).toHaveAttribute('aria-disabled', 'true');
		await expect.element(lock).not.toHaveAttribute('aria-pressed');
		// aria-disabled reads as disabled to the click helper; a tap still opens the hint.
		await lock.click({ force: true });
		await expect
			.element(page.getByRole('link', { name: 'Set one up in Settings → Providers' }))
			.toHaveAttribute('href', '/settings/providers');
	});

	it('toggles the private flag when a trusted provider exists', async () => {
		let last: boolean | undefined;
		render(PrivateChatToggle, {
			status: status({}),
			onchange: (checked: boolean) => (last = checked)
		});
		const lock = page.getByRole('button', { name: 'Private chat' });
		await expect.element(lock).toHaveAttribute('aria-pressed', 'false');
		await lock.click();
		await expect.element(lock).toHaveAttribute('aria-pressed', 'true');
		await expect.element(lock).toHaveTextContent('Private');
		expect(last).toBe(true);
	});
});
