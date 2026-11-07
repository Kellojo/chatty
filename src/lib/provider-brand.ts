import { BRAND_ICONS } from './brand-icons.js';

export type Brand = keyof typeof BRAND_ICONS;

/**
 * Keyword → brand, checked in order. More specific names come first so a
 * gateway (OpenRouter) or tool (OpenCode) isn't mistaken for a model vendor.
 */
const RULES: [RegExp, Brand][] = [
	[/openrouter/, 'openrouter'],
	[/opencode/, 'opencode'],
	[/cursor/, 'cursor'],
	[/antigravity/, 'antigravity'],
	[/ollama|:11434\b/, 'ollama'],
	[/lm[\s_-]?studio|:1234\b/, 'lmstudio'],
	[/claude|anthropic/, 'claude'],
	[/openai|codex|chatgpt|\bgpt\b|(^|\/)o\d\b/, 'openai'],
	[/gemini|gemma|generativelanguage\.googleapis|^google\//, 'gemini'],
	[/grok|\bx\.ai\b|\bx-?ai\b/, 'grok'],
	[/deepseek/, 'deepseek'],
	[/mistral|codestral|magistral|devstral/, 'mistral'],
	[/qwen|dashscope/, 'qwen'],
	[/\bmeta\b|llama/, 'meta']
];

/**
 * Brand for a chat model: the model's maker when its id or name gives it away
 * (`anthropic/claude-...` via OpenRouter shows Claude), else the provider.
 */
export function resolveModelBrand(
	model: { modelId: string; displayName?: string },
	provider?: { name: string; baseUrl: string | null; type: string } | null
): Brand | null {
	return (
		resolveBrand(model.modelId, model.displayName) ??
		(provider ? resolveProviderBrand(provider) : null)
	);
}

/** Brand for a chat provider: by its name, then base URL, then kind. */
export function resolveProviderBrand(provider: {
	name: string;
	baseUrl: string | null;
	type: string;
}): Brand | null {
	return resolveBrand(
		provider.name,
		provider.baseUrl,
		provider.type === 'anthropic' ? provider.type : null
	);
}

/**
 * Picks a brand from hints such as a provider's name, kind or base URL. Hints
 * are tried in order, so put the most telling one first; null when none match.
 */
export function resolveBrand(...hints: (string | null | undefined)[]): Brand | null {
	for (const hint of hints) {
		if (!hint) continue;
		const text = hint.toLowerCase();
		for (const [pattern, brand] of RULES) if (pattern.test(text)) return brand;
	}
	return null;
}
