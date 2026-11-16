import type { ProviderId, SearchResult } from './providers.js';

/** A result found by one or more providers; `via` lists them in the given provider order. */
export type MergedResult = SearchResult & { via: ProviderId[] };

/** Reciprocal rank fusion's usual constant: damps the weight of top ranks. */
const RRF_K = 60;
const TRACKING_PARAM = /^(?:utm_.*|fbclid|gclid|mc_cid|mc_eid|ref_src)$/i;

/**
 * What two results must share to count as the same page: scheme, `www.`, default port,
 * fragment, tracking parameters, parameter order and one trailing slash are ignored.
 * A URL that doesn't parse is compared as-is.
 */
export function urlKey(raw: string): string {
	let u: URL;
	try {
		u = new URL(raw.trim());
	} catch {
		return raw.trim();
	}
	const host = u.hostname.toLowerCase().replace(/^www\./, '');
	const port = u.port && u.port !== '80' && u.port !== '443' ? `:${u.port}` : '';
	const params = [...u.searchParams]
		.filter(([name]) => !TRACKING_PARAM.test(name))
		.sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
	const query = params.length ? `?${new URLSearchParams(params)}` : '';
	const path = u.pathname.length > 1 ? u.pathname.replace(/\/$/, '') : '';
	return `${host}${port}${path}${query}`;
}

interface Occurrence {
	result: SearchResult;
	provider: ProviderId;
	/** 1-based position in that provider's list. */
	rank: number;
	providerIndex: number;
}

const isFaviconGuess = (card: SearchResult['card']) =>
	!card.favicon ||
	(URL.canParse(card.url) && card.favicon === new URL('/favicon.ico', card.url).href);

/** The earliest date when the providers' dates parse; otherwise the best-ranked one's. */
function earliest(occurrences: Occurrence[]): string | undefined {
	const dated = occurrences
		.map((o) => o.result.published)
		.filter((d): d is string => !!d && !Number.isNaN(Date.parse(d)));
	if (dated.length) return dated.reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a));
	return occurrences.find((o) => o.result.published)?.result.published;
}

/** One card from every provider's copy of the same page. */
function mergeOccurrences(occurrences: Occurrence[]): MergedResult {
	// Best-ranked first; equal ranks follow the provider order.
	const sorted = [...occurrences].sort(
		(a, b) => a.rank - b.rank || a.providerIndex - b.providerIndex
	);
	const best = sorted[0].result;
	const https = sorted.find((o) => o.result.card.url.startsWith('https:'));
	const url =
		best.card.url.startsWith('http:') && https
			? best.card.url.replace(/^http:/, 'https:')
			: best.card.url;
	const description = sorted
		.map((o) => o.result.card.description)
		.filter((d): d is string => !!d)
		.reduce<string | undefined>((a, b) => (!a || b.length > a.length ? b : a), undefined);
	const iconFrom = sorted.find((o) => !isFaviconGuess(o.result.card)) ?? sorted[0];
	const image = sorted.find((o) => o.result.card.image)?.result.card.image;
	const card = Object.fromEntries(
		Object.entries({
			...best.card,
			url,
			description,
			favicon: iconFrom.result.card.favicon,
			image
		}).filter(([, v]) => v !== undefined)
	) as SearchResult['card'];
	const via = [...new Set(occurrences.map((o) => o.provider))].sort(
		(a, b) =>
			occurrences.find((o) => o.provider === a)!.providerIndex -
			occurrences.find((o) => o.provider === b)!.providerIndex
	);
	const published = earliest(sorted);
	return published ? { card, published, via } : { card, via };
}

/**
 * Merges several providers' ranked lists into one, with reciprocal rank fusion: a page
 * scores Σ 1 / (60 + rank) over the providers that found it, so agreement between
 * engines lifts it. Ties go to the best single rank, then `order`. Returns at most `limit`.
 */
export function fuseResults(
	lists: { provider: ProviderId; results: SearchResult[] }[],
	order: readonly ProviderId[],
	limit: number
): MergedResult[] {
	const pages = new Map<string, Occurrence[]>();
	for (const { provider, results } of lists) {
		const providerIndex = order.indexOf(provider);
		const seen = new Set<string>();
		results.forEach((result, i) => {
			const key = urlKey(result.card.url);
			// A repeat inside one list counts once, at its best (first) rank.
			if (seen.has(key)) return;
			seen.add(key);
			const occurrence = { result, provider, rank: i + 1, providerIndex };
			pages.set(key, [...(pages.get(key) ?? []), occurrence]);
		});
	}
	const scored = [...pages.values()].map((occurrences) => ({
		score: occurrences.reduce((sum, o) => sum + 1 / (RRF_K + o.rank), 0),
		bestRank: Math.min(...occurrences.map((o) => o.rank)),
		firstProvider: Math.min(
			...occurrences
				.filter((o) => o.rank === Math.min(...occurrences.map((x) => x.rank)))
				.map((o) => o.providerIndex)
		),
		occurrences
	}));
	scored.sort(
		(a, b) => b.score - a.score || a.bestRank - b.bestRank || a.firstProvider - b.firstProvider
	);
	return scored.slice(0, limit).map((s) => mergeOccurrences(s.occurrences));
}
