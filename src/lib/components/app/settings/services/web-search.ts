import { invalidateAll } from '$app/navigation';
import { toast } from 'svelte-sonner';
import { aaRequest } from '../artificial-analysis.svelte.js';

export type WebSearchProvider = 'searxng' | 'brave' | 'perplexity';
export type SearchMode = 'combined' | 'fallback';

type Source = 'env' | 'app' | null;

/** Mirrors the server's `WebSearchInfo` (server code can't be imported here). */
export interface WebSearchState {
	searxng: { source: Source; url: string | null };
	brave: { source: Source; hint: string | null };
	perplexity: { source: Source; hint: string | null };
	defaultProvider: WebSearchProvider | null;
	mode: SearchMode;
	backupOnly: WebSearchProvider[];
	order: {
		fallback: WebSearchProvider[];
		combined: WebSearchProvider[];
		backup: WebSearchProvider[];
	};
}

/** The fixed provider order, as the server uses it. */
export const WEB_SEARCH_PROVIDERS: readonly WebSearchProvider[] = [
	'searxng',
	'brave',
	'perplexity'
];

export const WEB_SEARCH_NAMES: Record<WebSearchProvider, string> = {
	searxng: 'SearXNG',
	brave: 'Brave Search',
	perplexity: 'Perplexity'
};

export const connectedProviders = (info: WebSearchState) =>
	WEB_SEARCH_PROVIDERS.filter((p) => info[p].source !== null);

/** "A", "A and B", "A, B and C". */
export function nameList(ids: readonly WebSearchProvider[]): string {
	const names = ids.map((id) => WEB_SEARCH_NAMES[id]);
	return names.length < 2
		? (names[0] ?? '')
		: `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** What one connected provider does in searches right now, in a sentence. */
export function searchRole(info: WebSearchState, id: WebSearchProvider): string {
	const others = (ids: readonly WebSearchProvider[]) => ids.filter((p) => p !== id);
	if (info.mode === 'combined') {
		if (info.order.backup.includes(id)) {
			return `Backup: searched only when ${nameList(info.order.combined)} ${
				info.order.combined.length > 1 ? "don't" : "doesn't"
			} answer.`;
		}
		const together = others(info.order.combined);
		return together.length
			? `Searched together with ${nameList(together)} on every search.`
			: 'Searched on every search.';
	}
	const position = info.order.fallback.indexOf(id);
	if (position === 0) return 'Default: answers every search on its own.';
	return `Tried only when ${nameList(info.order.fallback.slice(0, position))} ${
		position > 1 ? 'all fail' : 'fails'
	}.`;
}

/** Saves search preferences and reloads the page data; false (with a toast) on failure. */
export async function saveSearchPreferences(prefs: {
	mode?: SearchMode;
	defaultProvider?: WebSearchProvider;
	backupOnly?: WebSearchProvider[];
}): Promise<boolean> {
	try {
		await aaRequest('PUT', '/api/websearch/preferences', prefs);
		await invalidateAll();
		return true;
	} catch (e) {
		toast.error(e instanceof Error ? e.message : 'Could not save the search settings');
		return false;
	}
}
