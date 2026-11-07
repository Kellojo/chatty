import { describe, expect, it } from 'vitest';
import { parseFavorites, parseModels, resolveDefaultModel } from './options.js';

const config = {
	providers: [
		{
			instanceId: 'claudeAgent',
			driver: 'claudeAgent',
			enabled: true,
			installed: true,
			status: 'ready',
			displayName: 'Claude',
			models: [
				{ slug: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
				{ slug: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
				{ slug: 'claude-old', name: 'Old', isLegacy: true }
			]
		},
		{
			instanceId: 'acpRegistry_opencode',
			driver: 'acpRegistry',
			enabled: false,
			installed: false,
			status: 'disabled',
			models: [{ slug: 'provider-id/code-remote', name: 'Remote' }]
		}
	]
};

const settings = {
	defaultModelSelection: { instanceId: 'acpRegistry_opencode', model: 'provider-id/code-remote' },
	favorites: [
		{ provider: 'acpRegistry_opencode', model: 'provider-id/code-remote' },
		{ provider: 'claudeAgent', model: 'claude-opus-5-5' },
		{ provider: 'broken' }
	]
};

describe('t3 coding options', () => {
	it('parses favorites and lists them first within their provider', () => {
		const favorites = parseFavorites(settings);
		expect(favorites).toHaveLength(2);
		const models = parseModels(config, favorites);
		expect(models.map((m) => [m.model, m.favorite])).toEqual([
			['claude-opus-5-5', true],
			['claude-sonnet-5-5', false]
		]);
	});

	it('uses the first available candidate as the default', () => {
		const models = parseModels(config, parseFavorites(settings));
		expect(
			resolveDefaultModel(
				[null, { providerInstanceId: 'claudeAgent', model: 'claude-sonnet-5-5' }],
				models
			)
		).toEqual({ providerInstanceId: 'claudeAgent', model: 'claude-sonnet-5-5' });
	});

	it('falls back to a favorite when the configured default is unavailable', () => {
		const models = parseModels(config, parseFavorites(settings));
		const unavailable = {
			providerInstanceId: 'acpRegistry_opencode',
			model: 'provider-id/code-remote'
		};
		expect(resolveDefaultModel([unavailable], models)).toEqual({
			providerInstanceId: 'claudeAgent',
			model: 'claude-opus-5-5'
		});
	});

	it('falls back to the first model without favorites, and null without models', () => {
		const models = parseModels(config);
		expect(resolveDefaultModel([null], models)?.model).toBe('claude-sonnet-5-5');
		expect(resolveDefaultModel([null], [])).toBeNull();
	});
});
