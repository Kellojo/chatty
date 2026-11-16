import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import '../../../../routes/layout.css';
import StepConcepts from './StepConcepts.svelte';

const props = (patch: Record<string, unknown>) => ({
	isAdmin: false,
	hasModel: true,
	onback: () => {},
	onnext: () => {},
	...patch
});

describe('StepConcepts: private data', () => {
	it('shows admins the concept, with where to turn it on', async () => {
		render(StepConcepts, props({ isAdmin: true, privateDataEnabled: false }));
		await page.getByRole('tab', { name: /Private data/ }).click();
		await expect
			.element(page.getByText(/Turn it on in Settings → Private data/))
			.toBeInTheDocument();
	});

	it('shows users the concept only when private data is on', async () => {
		const off = render(StepConcepts, props({ privateDataEnabled: false }));
		await expect.element(page.getByRole('tab', { name: /Memory/ })).toBeInTheDocument();
		expect(off.container.textContent).not.toContain('Private data');
		off.unmount();

		render(StepConcepts, props({ privateDataEnabled: true }));
		await page.getByRole('tab', { name: /Private data/ }).click();
		await expect.element(page.getByText('The lock next to the message box')).toBeInTheDocument();
	});
});
