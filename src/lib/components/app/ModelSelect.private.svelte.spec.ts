import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import '../../../routes/layout.css';
import Harness from './test-harness/ModelSelectHarness.svelte';
import type { ModelMapping, ModelsByProvider } from '$lib/types.js';

const group = (id: string, name: string, allowPrivate: boolean): ModelsByProvider => ({
	provider: {
		id,
		name,
		type: 'openai-compatible',
		baseUrl: null,
		hasApiKey: true,
		enabled: true,
		allowPrivate,
		createdAt: 0
	},
	models: [
		{
			id: `${id}-m`,
			providerId: id,
			modelId: `${id}-model`,
			displayName: `${name} model`,
			capabilities: ['chat'],
			enabled: true,
			priceInput: null,
			priceOutput: null
		}
	]
});

const groups = [group('local', 'LM Studio', true), group('cloud', 'OpenRouter', false)];

const mapping = (id: string, name: string, providers: string[]): ModelMapping => ({
	id,
	name,
	targets: providers.map((providerId) => ({ providerId, modelId: `${providerId}-model` })),
	enabled: true,
	trustedOnly: false,
	createdAt: 0
});
const mappings = [
	mapping('m1', 'local-only', ['local']),
	mapping('m2', 'mixed', ['local', 'cloud'])
];

async function open(container: HTMLElement) {
	const trigger = container.querySelector<HTMLElement>('[data-slot="select-trigger"]');
	if (!trigger) throw new Error('no trigger');
	await page.elementLocator(trigger).click();
}

const option = (name: RegExp) => page.getByRole('option', { name });

describe('ModelSelect in a private chat', () => {
	it('greys out models and mappings that may reach an untrusted provider', async () => {
		const screen = render(Harness, {
			groups,
			mappings,
			favorites: [],
			value: 'local/local-model',
			privateOnly: true
		});
		await open(screen.container);
		await expect.element(page.getByText('Private chat: trusted models only')).toBeInTheDocument();
		await expect.element(option(/LM Studio model/)).not.toHaveAttribute('data-disabled');
		await expect.element(option(/OpenRouter model/)).toHaveAttribute('data-disabled');
		await expect.element(option(/local-only/)).not.toHaveAttribute('data-disabled');
		await expect.element(option(/mixed/)).toHaveAttribute('data-disabled');
	});

	it('flags a selected model that is not trusted', async () => {
		const screen = render(Harness, {
			groups,
			mappings,
			favorites: [],
			value: 'cloud/cloud-model',
			privateOnly: true
		});
		const trigger = screen.container.querySelector<HTMLElement>('[data-slot="select-trigger"]')!;
		expect(trigger.title).toContain('not trusted with private data');
	});

	it('leaves every model selectable outside private chats', async () => {
		const screen = render(Harness, { groups, mappings, favorites: [], value: '' });
		await open(screen.container);
		await expect.element(option(/OpenRouter model/)).not.toHaveAttribute('data-disabled');
		await expect.element(option(/mixed/)).not.toHaveAttribute('data-disabled');
		expect(document.body.textContent).not.toContain('Private chat: trusted models only');
	});
});
