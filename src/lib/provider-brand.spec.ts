import { describe, expect, it } from 'vitest';
import { resolveBrand, resolveModelBrand } from './provider-brand.js';

describe('resolveBrand', () => {
	it('maps coding agent drivers', () => {
		expect(resolveBrand('claudeAgent')).toBe('claude');
		expect(resolveBrand('codex')).toBe('openai');
		expect(resolveBrand('cursor')).toBe('cursor');
		expect(resolveBrand('acpRegistry_opencode')).toBe('opencode');
		expect(resolveBrand('grok')).toBe('grok');
		expect(resolveBrand('antigravity')).toBe('antigravity');
	});

	it('maps chat providers by name, then kind or base URL', () => {
		expect(resolveBrand('My Anthropic')).toBe('claude');
		expect(resolveBrand('Work', 'https://openrouter.ai/api/v1')).toBe('openrouter');
		expect(resolveBrand('Local', 'http://localhost:11434/v1')).toBe('ollama');
		expect(resolveBrand('OpenRouter', 'anthropic')).toBe('openrouter');
	});

	it("prefers the model's maker over a gateway provider", () => {
		const openrouter = { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', type: 'x' };
		const brand = (modelId: string) => resolveModelBrand({ modelId }, openrouter);
		expect(brand('anthropic/claude-sonnet-4.5')).toBe('claude');
		expect(brand('openai/gpt-5')).toBe('openai');
		expect(brand('openai/o4-mini')).toBe('openai');
		expect(brand('google/gemini-2.5-pro')).toBe('gemini');
		expect(brand('x-ai/grok-4')).toBe('grok');
		expect(brand('meta-llama/llama-4-maverick')).toBe('meta');
		expect(brand('mistralai/devstral-medium')).toBe('mistral');
		expect(brand('some-lab/unknown-model')).toBe('openrouter');
		expect(resolveModelBrand({ modelId: 'o3' })).toBe('openai');
		expect(resolveModelBrand({ modelId: 'qwen3:8b' }, null)).toBe('qwen');
	});

	it('returns null when nothing matches', () => {
		expect(resolveBrand('Home server', null, 'http://10.0.0.5:8000/v1')).toBeNull();
		expect(resolveBrand()).toBeNull();
	});
});
