import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import '../../../routes/layout.css';
import Harness from './test-harness/ModelSelectHarness.svelte';
import type { ModelsByProvider } from '$lib/types.js';

const groups: ModelsByProvider[] = [
	{
		provider: {
			id: 'p1',
			name: 'OpenRouter',
			type: 'openai-compatible',
			baseUrl: 'https://openrouter.ai/api/v1',
			hasApiKey: true,
			enabled: true,
			createdAt: 0
		},
		models: Array.from({ length: 40 }, (_, i) => ({
			id: `id${i}`,
			providerId: 'p1',
			modelId: `anthropic/model-${i}`,
			displayName: `Model ${i}`,
			capabilities: ['chat'],
			enabled: true
		})) as ModelsByProvider['models']
	}
];

function openPicker(container: HTMLElement) {
	const trigger = container.querySelector<HTMLElement>('[data-slot="select-trigger"]');
	if (!trigger) throw new Error('no trigger');
	return page.elementLocator(trigger).click();
}

describe('ModelSelect favorites', () => {
	it('keeps Favorites in view when the selected model is not a favorite', async () => {
		await page.viewport(800, 600);
		const screen = render(Harness, {
			groups,
			favorites: ['p1/anthropic/model-0'],
			value: 'p1/anthropic/model-39'
		});
		await openPicker(screen.container);
		await expect.element(page.getByRole('option', { name: /Model 39/ })).toBeInTheDocument();
		// Let bits-ui position the list and scroll to the selection.
		await new Promise((r) => setTimeout(r, 200));
		const list = document.querySelector<HTMLElement>('[data-select-viewport]')!;
		expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
		await expect.element(page.getByText('Favorites')).toBeInViewport();
	});

	it('shows the Favorites hint when nothing is starred', async () => {
		const screen = render(Harness, { groups, favorites: [], value: '' });
		await openPicker(screen.container);
		await expect.element(page.getByText('Star a model to pin it here.')).toBeInTheDocument();
	});
});
