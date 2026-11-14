import { describe, expect, it } from 'vitest';
import type { AaModel } from '../db/repo/aa-models.js';
import { keys, matchScores, tokens } from './match.js';

const aa = (slug: string, name: string, intelligenceIndex: number | null): AaModel => ({
	id: `id-${slug}-${name}`,
	slug,
	name,
	creator: null,
	intelligenceIndex,
	releaseDate: null
});

const model = (modelId: string, displayName = modelId) => ({
	id: `row-${modelId}`,
	modelId,
	displayName
});

describe('tokens', () => {
	it('drops the vendor prefix, :tags, date suffixes and noise words', () => {
		expect(tokens('z-ai/glm-5.3')).toEqual(['glm', '5', '3']);
		expect(tokens('openai/gpt-4o:free')).toEqual(['gpt', '4o']);
		expect(tokens('claude-sonnet-4-5-20250929')).toEqual(['claude', 'sonnet', '4', '5']);
		expect(tokens('gemini-2.5-pro-2025-06-05')).toEqual(['gemini', '2', '5', 'pro']);
		expect(tokens('chatgpt-4o-latest')).toEqual(['chatgpt', '4o']);
	});

	it('gives slugs and display names the same keys', () => {
		expect(keys('glm-5-3')).toEqual(keys('GLM-5.3'));
		expect(keys('meta-llama/llama-3.1-8b-instruct')).toContain(keys('Llama 3.1 Instruct 8B')[1]);
	});
});

describe('matchScores', () => {
	it('matches by normalised id, ignoring vendor and punctuation', () => {
		const scores = matchScores(
			[model('z-ai/glm-5.3'), model('openai/gpt-4o')],
			[aa('glm-5-3', 'GLM-5.3', 31.7), aa('gpt-4o', 'GPT-4o', 25)]
		);
		expect(scores['row-z-ai/glm-5.3']).toEqual({
			index: 31.7,
			aaName: 'GLM-5.3',
			aaSlug: 'glm-5-3'
		});
		expect(scores['row-openai/gpt-4o']?.index).toBe(25);
	});

	it('matches regardless of word order', () => {
		const scores = matchScores(
			[model('meta-llama/llama-3.1-8b-instruct')],
			[aa('llama-3-1-instruct-8b', 'Llama 3.1 Instruct 8B', 12)]
		);
		expect(scores['row-meta-llama/llama-3.1-8b-instruct']?.index).toBe(12);
	});

	it('prefers the plain entry over "(Reasoning)" variants', () => {
		const scores = matchScores(
			[model('vendor/foo-2')],
			[aa('foo-2-reasoning', 'Foo 2 (Reasoning)', 40), aa('foo-2', 'Foo 2', 30)]
		);
		expect(scores['row-vendor/foo-2']).toMatchObject({ index: 30, aaName: 'Foo 2' });
	});

	it('falls back to the best variant when there is no plain entry', () => {
		const scores = matchScores(
			[model('z-ai/glm-5.3')],
			[aa('glm-5-3-low', 'GLM-5.3 (Low)', 20), aa('glm-5-3', 'GLM-5.3 (Max)', 31.7)]
		);
		expect(scores['row-z-ai/glm-5.3']).toMatchObject({ index: 31.7, aaName: 'GLM-5.3 (Max)' });
	});

	it('uses the display name when the id gives nothing away', () => {
		const scores = matchScores(
			[model('custom-deployment-1', 'GPT-4o')],
			[aa('gpt-4o', 'GPT-4o', 25)]
		);
		expect(scores['row-custom-deployment-1']?.index).toBe(25);
	});

	it('leaves unknown models and unscored entries out', () => {
		const scores = matchScores(
			[model('acme/unknown-model'), model('vendor/bar-1')],
			[aa('bar-1', 'Bar 1', null)]
		);
		expect(scores).toEqual({});
	});
});
