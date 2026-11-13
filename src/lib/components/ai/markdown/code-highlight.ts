// Streamdown highlights every code block with Shiki on each mount, and the
// chat view remounts all messages when switching chats. This code plugin keeps
// the tokens of recently highlighted blocks, so revisiting a chat reuses them
// instead of tokenizing every block again.
//
// Tokenizing is still done by Streamdown's own shared highlighter (the one its
// built-in path uses), so languages, themes and output stay the same.

import type {
	CodeHighlighterPlugin,
	HighlightOptions,
	HighlightResult,
	HighlightToken,
	ThemeInput
} from 'streamdown-svelte';

/** The parts of Streamdown's shared `HighlighterManager` this plugin uses. */
export type SharedHighlighter = {
	isReady(theme: string, language: string): boolean;
	load(theme: string, language: string): Promise<void>;
	highlightCode(code: string, language: string, theme: string): HighlightToken[][];
};

type CacheOptions = {
	/** Most blocks kept. */
	maxEntries?: number;
	/** Most code characters kept across all blocks. */
	maxChars?: number;
};

type Entry = { result: HighlightResult; chars: number };

export const themeName = (theme: ThemeInput): string =>
	typeof theme === 'string' ? theme : (theme.name ?? 'custom-theme');

/**
 * A least-recently-used cache of highlighted blocks. A block that grows while
 * streaming replaces its previous, shorter version, so one long streamed block
 * doesn't push out everything else.
 */
export function createTokenCache({ maxEntries = 500, maxChars = 2_000_000 }: CacheOptions = {}) {
	const entries = new Map<string, Entry>();
	let chars = 0;
	let last: { key: string; prefix: string; code: string } | null = null;

	function remove(key: string) {
		const entry = entries.get(key);
		if (!entry) return;
		entries.delete(key);
		chars -= entry.chars;
	}

	return {
		get(key: string): HighlightResult | undefined {
			const entry = entries.get(key);
			if (!entry) return undefined;
			// Re-insert to mark it as recently used.
			entries.delete(key);
			entries.set(key, entry);
			return entry.result;
		},
		/** `prefix` identifies the language and theme; `code` is the block's text. */
		set(prefix: string, code: string, result: HighlightResult) {
			const key = prefix + code;
			if (
				last &&
				last.prefix === prefix &&
				last.key !== key &&
				code.length > last.code.length &&
				code.startsWith(last.code)
			) {
				remove(last.key);
			}
			remove(key);
			entries.set(key, { result, chars: code.length });
			chars += code.length;
			last = { key, prefix, code };
			for (const oldest of entries.keys()) {
				if (entries.size <= maxEntries && chars <= maxChars) break;
				if (oldest === key) break;
				remove(oldest);
			}
		},
		get size() {
			return entries.size;
		}
	};
}

/**
 * A Streamdown code plugin that tokenizes with `getHighlighter()` and caches
 * the result. `getThemes()` is the active theme twice, so the theme follows
 * the app's mode instead of Streamdown's own dark-mode detection.
 */
export function createCachedCodePlugin(
	getHighlighter: () => SharedHighlighter | undefined,
	getThemes: () => [ThemeInput, ThemeInput],
	cacheOptions?: CacheOptions
): CodeHighlighterPlugin {
	const cache = createTokenCache(cacheOptions);

	return {
		name: 'shiki',
		type: 'code-highlighter',
		getThemes,
		// Only Streamdown's own highlighter knows which languages it can load,
		// and nothing calls these for rendering.
		getSupportedLanguages: () => [],
		supportsLanguage: () => true,
		highlight(options: HighlightOptions & { activeTheme?: ThemeInput }, callback) {
			const theme = themeName(options.activeTheme ?? options.themes[0]);
			const { code, language } = options;
			const prefix = `${theme}\u0000${language}\u0000`;
			const cached = cache.get(prefix + code);
			if (cached) return cached;

			const highlighter = getHighlighter();
			if (!highlighter) return null;
			const produce = (): HighlightResult => {
				const result = { tokens: highlighter.highlightCode(code, language, theme) };
				cache.set(prefix, code, result);
				return result;
			};
			if (highlighter.isReady(theme, language)) return produce();
			void highlighter.load(theme, language).then(
				() => callback?.(produce()),
				() => callback?.(produce())
			);
			return null;
		}
	};
}

/**
 * Streamdown's code block creates (or reuses) its shared highlighter before
 * asking the plugin to highlight, and registers it on `window` to share it.
 */
export function streamdownHighlighter(): SharedHighlighter | undefined {
	if (typeof window === 'undefined') return undefined;
	return (window as { STREAMDOWN_HIGHLIGHTER?: SharedHighlighter }).STREAMDOWN_HIGHLIGHTER;
}
