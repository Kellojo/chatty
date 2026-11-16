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
		expect(resolveBrand('Search', 'https://api.perplexity.ai')).toBe('perplexity');
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
		expect(brand('perplexity/sonar-pro')).toBe('perplexity');
		expect(resolveModelBrand({ modelId: 'sonar-reasoning-pro' })).toBe('perplexity');
		expect(brand('some-lab/unknown-model')).toBe('openrouter');
		expect(resolveModelBrand({ modelId: 'o3' })).toBe('openai');
		expect(resolveModelBrand({ modelId: 'qwen3:8b' }, null)).toBe('qwen');
	});

	it('maps hosts whose base URL mentions openai to the host', () => {
		expect(resolveBrand('Fast', 'https://api.groq.com/openai/v1')).toBe('groq');
		expect(resolveBrand('Infra', 'https://api.deepinfra.com/v1/openai')).toBe('deepinfra');
		expect(resolveBrand('Work', 'https://acme.openai.azure.com/openai')).toBe('microsoft');
		expect(resolveBrand('Copilot', 'https://api.githubcopilot.com')).toBe('githubcopilot');
		expect(resolveBrand('AWS', 'https://bedrock-runtime.us-east-1.amazonaws.com')).toBe('bedrock');
	});

	it('maps more model makers', () => {
		expect(resolveModelBrand({ modelId: 'moonshotai/kimi-k2' })).toBe('kimi');
		expect(resolveModelBrand({ modelId: 'z-ai/glm-4.6' })).toBe('zai');
		expect(resolveModelBrand({ modelId: 'minimax/minimax-m2' })).toBe('minimax');
		expect(resolveModelBrand({ modelId: 'cohere/command-a' })).toBe('cohere');
		expect(resolveModelBrand({ modelId: 'perplexity/sonar-pro' })).toBe('perplexity');
		expect(resolveModelBrand({ modelId: 'microsoft/phi-4' })).toBe('microsoft');
		expect(resolveModelBrand({ modelId: 'nvidia/llama-3.1-nemotron-70b' })).toBe('nvidia');
		expect(resolveModelBrand({ modelId: 'hf.co/unsloth/Qwen3-8B-GGUF' })).toBe('qwen');
		const fireworks = {
			name: 'Fireworks',
			baseUrl: 'https://api.fireworks.ai/inference/v1',
			type: 'x'
		};
		expect(resolveModelBrand({ modelId: 'accounts/fireworks/models/kimi-k2' }, fireworks)).toBe(
			'kimi'
		);
		expect(resolveModelBrand({ modelId: 'some-model' }, fireworks)).toBe('fireworks');
	});

	it('returns null when nothing matches', () => {
		expect(resolveBrand('Home server', null, 'http://10.0.0.5:8000/v1')).toBeNull();
		expect(resolveBrand()).toBeNull();
	});
});
