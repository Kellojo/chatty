import type { Brand } from './provider-brand.js';

export type ProviderType = 'anthropic' | 'openai-compatible';

export interface ProviderPreset {
	id: string;
	label: string;
	type: ProviderType;
	/** Prefilled endpoint; empty means the user types one (or the type's default). */
	baseUrl: string;
	/** Runs on the user's machine: no key needed, and the URL is often edited. */
	local?: boolean;
	brand?: Brand;
	/** Where to create a key, linked from onboarding. */
	keyUrl?: string;
	/** One line on what the preset is, for onboarding's tile grid. */
	blurb: string;
}

/** Known endpoints, shared by Settings → Providers and onboarding. */
export const PROVIDER_PRESETS: ProviderPreset[] = [
	{
		id: 'anthropic',
		label: 'Anthropic',
		type: 'anthropic',
		baseUrl: '',
		brand: 'claude',
		keyUrl: 'https://console.anthropic.com/settings/keys',
		blurb: 'Claude models'
	},
	{
		id: 'openai',
		label: 'OpenAI',
		type: 'openai-compatible',
		baseUrl: 'https://api.openai.com/v1',
		brand: 'openai',
		keyUrl: 'https://platform.openai.com/api-keys',
		blurb: 'GPT models'
	},
	{
		id: 'openrouter',
		label: 'OpenRouter',
		type: 'openai-compatible',
		baseUrl: 'https://openrouter.ai/api/v1',
		brand: 'openrouter',
		keyUrl: 'https://openrouter.ai/keys',
		blurb: 'Hundreds of models, one key'
	},
	{
		id: 'ollama',
		label: 'Ollama',
		type: 'openai-compatible',
		baseUrl: 'http://localhost:11434/v1',
		local: true,
		brand: 'ollama',
		blurb: 'Local models, no key'
	},
	{
		id: 'lm-studio',
		label: 'LM Studio',
		type: 'openai-compatible',
		baseUrl: 'http://localhost:1234/v1',
		local: true,
		brand: 'lmstudio',
		blurb: 'Local models, no key'
	},
	{
		id: 'groq',
		label: 'Groq',
		type: 'openai-compatible',
		baseUrl: 'https://api.groq.com/openai/v1',
		brand: 'groq',
		keyUrl: 'https://console.groq.com/keys',
		blurb: 'Very fast open models'
	},
	{
		id: 'together',
		label: 'Together AI',
		type: 'openai-compatible',
		baseUrl: 'https://api.together.xyz/v1',
		brand: 'together',
		keyUrl: 'https://api.together.ai/settings/api-keys',
		blurb: 'Open models in the cloud'
	},
	{
		id: 'deepseek',
		label: 'DeepSeek',
		type: 'openai-compatible',
		baseUrl: 'https://api.deepseek.com/v1',
		brand: 'deepseek',
		keyUrl: 'https://platform.deepseek.com/api_keys',
		blurb: 'DeepSeek models'
	},
	{
		id: 'mistral',
		label: 'Mistral',
		type: 'openai-compatible',
		baseUrl: 'https://api.mistral.ai/v1',
		brand: 'mistral',
		keyUrl: 'https://console.mistral.ai/api-keys',
		blurb: 'Mistral models'
	},
	{
		id: 'custom',
		label: 'Custom',
		type: 'openai-compatible',
		baseUrl: '',
		blurb: 'Any OpenAI-compatible URL'
	}
];
