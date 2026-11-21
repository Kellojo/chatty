import { config } from '../config.js';
import { decryptSecret, encryptSecret } from '../crypto.js';
import type { Db } from '../db/index.js';
import { deleteSetting, getSetting, setSetting } from '../db/repo/settings.js';
import { createLogger } from '../logger.js';
import {
	normalizeSearxngUrl,
	PROVIDER_NAMES,
	PROVIDER_TYPES,
	searchBrave,
	searchPerplexity,
	searchPlaces as searchBravePlaces,
	searchSearxng,
	searchSearxngPlaces,
	isNamedPlaceQuery,
	verifySearxng,
	WebSearchError,
	type FetchImpl,
	type Place,
	type PlaceQuery,
	type ProviderId,
	type SearchOptions,
	type SearchResult,
	type SearchType
} from './providers.js';
import { fuseResults, type MergedResult } from './merge.js';
import { GoogleMapsError } from '../maps/google.js';
import { getGoogleMapsKey, searchPlacesWithGoogle } from '../maps/service.js';

const log = createLogger('websearch');

const SEARXNG_URL_SETTING = 'websearch.searxng.url';
const DEFAULT_SETTING = 'websearch.default';
const MODE_SETTING = 'websearch.mode';
const BACKUP_SETTING = 'websearch.backupOnly';

/** The fixed provider order: Combined runs and lists them like this; Fallback after the default. */
export const PROVIDER_IDS = [
	'searxng',
	'brave',
	'perplexity'
] as const satisfies readonly ProviderId[];

/** Providers configured with an API key (SearXNG takes a URL instead). */
export type KeyProviderId = Exclude<ProviderId, 'searxng'>;
export const KEY_PROVIDERS = {
	brave: { setting: 'websearch.brave.apiKey', envVar: 'BRAVE_SEARCH_API_KEY' },
	perplexity: { setting: 'websearch.perplexity.apiKey', envVar: 'PERPLEXITY_API_KEY' }
} as const satisfies Record<KeyProviderId, { setting: string; envVar: keyof typeof config }>;

export const isKeyProvider = (id: string): id is KeyProviderId => id in KEY_PROVIDERS;

type Source = 'env' | 'app' | null;

export interface WebSearchInfo {
	searxng: { source: Source; url: string | null };
	brave: { source: Source; /** Last four characters. */ hint: string | null };
	perplexity: { source: Source; hint: string | null };
	/** Tried first in Fallback mode; null when no provider is configured. */
	defaultProvider: ProviderId | null;
	mode: SearchMode;
	/** Providers set to Backup only (may include ones not configured right now). */
	backupOnly: ProviderId[];
	/** How a web search uses the configured providers, in each mode. */
	order: SearchOrder;
}

// ── Configuration ────────────────────────────────────────────────────────────

function envSearxngUrl(): string | null {
	if (!config.SEARXNG_URL) return null;
	try {
		return normalizeSearxngUrl(config.SEARXNG_URL);
	} catch {
		return config.SEARXNG_URL.replace(/\/+$/, '');
	}
}

/** The env var wins, so Docker setups can pin it; otherwise the URL saved in the app. */
export function getSearxngUrl(db: Db): string | null {
	return envSearxngUrl() ?? getSetting<string>(db, SEARXNG_URL_SETTING) ?? null;
}

const envKey = (id: KeyProviderId): string | null =>
	(config[KEY_PROVIDERS[id].envVar] as string | undefined) || null;

function storedKey(db: Db, id: KeyProviderId): string | null {
	const blob = getSetting<string>(db, KEY_PROVIDERS[id].setting);
	if (!blob) return null;
	try {
		return decryptSecret(blob);
	} catch {
		log.warn(`Stored ${PROVIDER_NAMES[id]} key could not be decrypted (APP_SECRET changed?)`);
		return null;
	}
}

/** The env var wins over the key saved in the app. */
export function getApiKey(db: Db, id: KeyProviderId): string | null {
	return envKey(id) ?? storedKey(db, id);
}

const isConfigured = (db: Db, id: ProviderId) =>
	id === 'searxng' ? !!getSearxngUrl(db) : !!getApiKey(db, id);

/** Configured providers, the default first (Fallback's order before Backup only). */
export function configuredProviders(db: Db): ProviderId[] {
	const preferred = getSetting<string>(db, DEFAULT_SETTING);
	return PROVIDER_IDS.filter((id) => isConfigured(db, id)).sort(
		(a, b) => Number(b === preferred) - Number(a === preferred)
	);
}

/** Without a provider the web_search tool isn't offered to models at all. */
export function isWebSearchConfigured(db: Db): boolean {
	return PROVIDER_IDS.some((id) => isConfigured(db, id));
}

/** True when a configured provider can run this type of search. */
export function canSearch(db: Db, type: SearchType): boolean {
	return configuredProviders(db).some((id) => PROVIDER_TYPES[id].includes(type));
}

/**
 * Place search providers, best first: Google has photos and reviews, Brave ratings, and
 * both search around coordinates; SearXNG (OpenStreetMap) has none of that.
 */
const PLACE_PROVIDER_IDS = ['google', 'brave', 'searxng'] as const;
export type PlaceProviderId = (typeof PLACE_PROVIDER_IDS)[number];

export const PLACE_PROVIDER_NAMES: Record<PlaceProviderId, string> = {
	google: 'Google Maps',
	brave: PROVIDER_NAMES.brave,
	searxng: PROVIDER_NAMES.searxng
};

export function placeProviders(db: Db): PlaceProviderId[] {
	return PLACE_PROVIDER_IDS.filter((id) =>
		id === 'google' ? !!getGoogleMapsKey(db) : isConfigured(db, id)
	);
}

function keyInfo(db: Db, id: KeyProviderId) {
	const key = getApiKey(db, id);
	const source: Source = envKey(id) ? 'env' : storedKey(db, id) ? 'app' : null;
	return { source, hint: key ? key.slice(-4) : null };
}

export function getWebSearchInfo(db: Db): WebSearchInfo {
	const order = searchOrder(db);
	return {
		searxng: {
			source: envSearxngUrl() ? 'env' : getSetting<string>(db, SEARXNG_URL_SETTING) ? 'app' : null,
			url: getSearxngUrl(db)
		},
		brave: keyInfo(db, 'brave'),
		perplexity: keyInfo(db, 'perplexity'),
		defaultProvider: order.fallback[0] ?? null,
		mode: getSearchMode(db),
		backupOnly: getBackupOnly(db),
		order
	};
}

/** Saves the URL after a test query succeeds; a failing instance throws and changes nothing. */
export async function saveSearxngUrl(db: Db, raw: string, fetchImpl: FetchImpl = fetch) {
	const url = normalizeSearxngUrl(raw);
	await verifySearxng(url, fetchImpl);
	setSetting(db, SEARXNG_URL_SETTING, url);
	return url;
}

export function clearSearxngUrl(db: Db): void {
	deleteSetting(db, SEARXNG_URL_SETTING);
}

/** Saves the key, encrypted, after a real search with it succeeds. */
export async function saveApiKey(
	db: Db,
	id: KeyProviderId,
	apiKey: string,
	fetchImpl: FetchImpl = fetch
) {
	await searchWith(id, apiKey, 'chatty', { limit: 1 }, fetchImpl);
	setSetting(db, KEY_PROVIDERS[id].setting, encryptSecret(apiKey));
}

export function clearApiKey(db: Db, id: KeyProviderId): void {
	deleteSetting(db, KEY_PROVIDERS[id].setting);
}

// ── Search preferences ───────────────────────────────────────────────────────

export type SearchMode = 'combined' | 'fallback';
export const SEARCH_MODES = ['combined', 'fallback'] as const satisfies readonly SearchMode[];

/** Combined unless the admin picked Fallback, so installs without the setting combine. */
export function getSearchMode(db: Db): SearchMode {
	return getSetting<string>(db, MODE_SETTING) === 'fallback' ? 'fallback' : 'combined';
}

const knownIds = (value: unknown): ProviderId[] =>
	Array.isArray(value) ? PROVIDER_IDS.filter((id) => value.includes(id)) : [];

/**
 * Providers set to Backup only. Unknown ids are dropped; known ones that aren't configured
 * right now are kept, so reconnecting a provider keeps its setting.
 */
export function getBackupOnly(db: Db): ProviderId[] {
	return knownIds(getSetting<unknown>(db, BACKUP_SETTING));
}

export interface SearchPreferences {
	defaultProvider?: ProviderId;
	mode?: SearchMode;
	backupOnly?: string[];
}

/** Saves any of the preferences in one transaction; validate before calling. */
export function setSearchPreferences(db: Db, prefs: SearchPreferences): void {
	db.transaction(() => {
		if (prefs.defaultProvider) setSetting(db, DEFAULT_SETTING, prefs.defaultProvider);
		if (prefs.mode) setSetting(db, MODE_SETTING, prefs.mode);
		if (prefs.backupOnly) setSetting(db, BACKUP_SETTING, knownIds(prefs.backupOnly));
	})();
}

export interface SearchOrder {
	/** Fallback: tried one after another, until one answers. */
	fallback: ProviderId[];
	/** Combined: searched together. */
	combined: ProviderId[];
	/** Combined: searched only when none of `combined` answered. */
	backup: ProviderId[];
}

/**
 * Which providers a search uses, and how, for each mode. Backup-only providers come last
 * in Fallback and form the backup round in Combined, unless every capable provider is
 * backup-only: then they're all searched normally, so the switch can't turn search off.
 */
export function searchOrder(db: Db, type: SearchType = 'web'): SearchOrder {
	const capable = (id: ProviderId) => PROVIDER_TYPES[id].includes(type);
	const backupOnly = new Set(getBackupOnly(db));
	const byDefault = configuredProviders(db).filter(capable);
	const inOrder = PROVIDER_IDS.filter((id) => isConfigured(db, id) && capable(id));
	if (inOrder.every((id) => backupOnly.has(id))) {
		return { fallback: byDefault, combined: inOrder, backup: [] };
	}
	return {
		fallback: [
			...byDefault.filter((id) => !backupOnly.has(id)),
			...byDefault.filter((id) => backupOnly.has(id))
		],
		combined: inOrder.filter((id) => !backupOnly.has(id)),
		backup: inOrder.filter((id) => backupOnly.has(id))
	};
}

// ── Searching ────────────────────────────────────────────────────────────────

/** One round of a Combined search never takes longer than this. */
export const ROUND_TIMEOUT_MS = 10_000;
/** Once a provider has found something, the others get this much longer. */
export const GRACE_MS = 3_000;

function searchWith(
	id: ProviderId,
	target: string,
	query: string,
	opts: SearchOptions,
	fetchImpl: FetchImpl
): Promise<SearchResult[]> {
	switch (id) {
		case 'searxng':
			return searchSearxng(target, query, opts, fetchImpl);
		case 'brave':
			return searchBrave(target, query, opts, fetchImpl);
		case 'perplexity':
			return searchPerplexity(target, query, opts, fetchImpl);
	}
}

const targetOf = (db: Db, id: ProviderId) =>
	id === 'searxng' ? getSearxngUrl(db)! : getApiKey(db, id)!;

const errorMessage = (e: unknown, id: ProviderId) =>
	e instanceof WebSearchError
		? e.message
		: `${PROVIDER_NAMES[id]}: ${e instanceof Error ? e.message : String(e)}`;

export interface ProviderOutcome {
	id: ProviderId;
	/** `timed out`: cut off by a Combined round's time limits; `skipped`: not needed. */
	status: 'ok' | 'failed' | 'timed out' | 'skipped';
	/** Why it failed or timed out, ready to show. */
	error?: string;
	/** Ran in the backup round (Combined) or after the others (Fallback). */
	backup: boolean;
}

export interface WebSearchOutcome {
	mode: SearchMode;
	results: MergedResult[];
	/** Every provider the search could use, in the order they were considered. */
	providers: ProviderOutcome[];
}

/**
 * Searches as the admin configured: Combined (every provider at once, results merged) or
 * Fallback (one after another until one answers). Providers that can't run the search type
 * (news) are left out. Throws when none can, when every one failed, or with the caller's
 * abort reason when the caller cancels.
 */
export async function webSearch(
	db: Db,
	query: string,
	opts: SearchOptions,
	fetchImpl: FetchImpl = fetch
): Promise<WebSearchOutcome> {
	const type = opts.type ?? 'web';
	const order = searchOrder(db, type);
	if (order.fallback.length === 0) {
		throw new Error(
			type === 'news' && isWebSearchConfigured(db)
				? 'news search needs SearXNG or Brave Search; search the web instead'
				: 'web search is not configured'
		);
	}
	return getSearchMode(db) === 'fallback'
		? fallbackSearch(db, order, query, opts, fetchImpl)
		: combinedSearch(db, order, query, opts, fetchImpl);
}

async function fallbackSearch(
	db: Db,
	order: SearchOrder,
	query: string,
	opts: SearchOptions,
	fetchImpl: FetchImpl
): Promise<WebSearchOutcome> {
	const providers: ProviderOutcome[] = order.fallback.map((id) => ({
		id,
		status: 'skipped',
		backup: order.backup.includes(id)
	}));
	for (const outcome of providers) {
		try {
			const results = await searchWith(
				outcome.id,
				targetOf(db, outcome.id),
				query,
				opts,
				fetchImpl
			);
			outcome.status = 'ok';
			return {
				mode: 'fallback',
				results: results.map((r) => ({ ...r, via: [outcome.id] })),
				providers
			};
		} catch (e) {
			// The caller gave up (the turn was stopped): don't try the next provider.
			if (opts.signal?.aborted) throw e;
			outcome.status = 'failed';
			outcome.error = errorMessage(e, outcome.id);
			log.warn(`Web search via ${outcome.id} failed`, { error: outcome.error });
		}
	}
	throw new Error(providers.map((p) => p.error).join('; '));
}

class RoundCutOff extends Error {}

/** Runs one Combined round: every provider at once, within the cap and the grace window. */
async function runRound(
	db: Db,
	ids: ProviderId[],
	backup: boolean,
	query: string,
	opts: SearchOptions,
	fetchImpl: FetchImpl
): Promise<{
	outcomes: ProviderOutcome[];
	lists: { provider: ProviderId; results: SearchResult[] }[];
}> {
	const round = new AbortController();
	const signal = opts.signal ? AbortSignal.any([opts.signal, round.signal]) : round.signal;
	const cutOff = (why: string) => {
		if (!round.signal.aborted) round.abort(new RoundCutOff(why));
	};
	const cap = setTimeout(() => cutOff('time limit'), ROUND_TIMEOUT_MS);
	let grace: ReturnType<typeof setTimeout> | undefined;
	const started = Date.now();
	const lists: { provider: ProviderId; results: SearchResult[] }[] = [];
	const outcomes: ProviderOutcome[] = ids.map((id) => ({ id, status: 'skipped', backup }));
	try {
		await Promise.all(
			outcomes.map(async (outcome) => {
				try {
					const results = await searchWith(
						outcome.id,
						targetOf(db, outcome.id),
						query,
						{ ...opts, signal },
						fetchImpl
					);
					outcome.status = 'ok';
					lists.push({ provider: outcome.id, results });
					// The first useful answer starts the grace window for the rest.
					if (results.length > 0 && !grace) {
						grace = setTimeout(() => cutOff('grace window'), GRACE_MS);
					}
				} catch (e) {
					if (opts.signal?.aborted) return;
					if (e instanceof RoundCutOff) {
						outcome.status = 'timed out';
						outcome.error = `${PROVIDER_NAMES[outcome.id]} timed out`;
						// A cut-off request may still be billed: worth seeing if it keeps happening.
						log.info(`Web search via ${outcome.id} cut off by the ${e.message}`, {
							elapsedMs: Date.now() - started
						});
					} else {
						outcome.status = 'failed';
						outcome.error = errorMessage(e, outcome.id);
						log.warn(`Web search via ${outcome.id} failed`, { error: outcome.error });
					}
				}
			})
		);
	} finally {
		clearTimeout(cap);
		clearTimeout(grace);
	}
	if (opts.signal?.aborted) throw opts.signal.reason;
	return { outcomes, lists };
}

async function combinedSearch(
	db: Db,
	order: SearchOrder,
	query: string,
	opts: SearchOptions,
	fetchImpl: FetchImpl
): Promise<WebSearchOutcome> {
	const main = await runRound(db, order.combined, false, query, opts, fetchImpl);
	const providers = [...main.outcomes];
	let lists = main.lists;
	const answered = () => providers.some((p) => p.status === 'ok');
	if (!answered() && order.backup.length > 0) {
		const backup = await runRound(db, order.backup, true, query, opts, fetchImpl);
		providers.push(...backup.outcomes);
		lists = backup.lists;
	} else {
		providers.push(
			...order.backup.map((id): ProviderOutcome => ({ id, status: 'skipped', backup: true }))
		);
	}
	if (!answered()) {
		throw new Error(
			providers
				.filter((p) => p.error)
				.map((p) => p.error)
				.join('; ')
		);
	}
	return { mode: 'combined', results: fuseResults(lists, PROVIDER_IDS, opts.limit), providers };
}

export interface PlaceSearchOutcome {
	provider: PlaceProviderId;
	places: Place[];
	/**
	 * With places: why the providers before `provider` didn't answer. Without: which
	 * providers failed, so "nothing found" isn't mistaken for a full search.
	 */
	errors: string[];
}

export interface PlaceSearchOptions {
	/** Who searched: only they can load the photos found. */
	userId?: string;
	fetchImpl?: FetchImpl;
}

function runPlaceSearch(
	db: Db,
	id: PlaceProviderId,
	query: PlaceQuery,
	{ userId, fetchImpl = fetch }: PlaceSearchOptions
): Promise<Place[]> {
	if (id === 'google') return searchPlacesWithGoogle(db, query, userId, fetchImpl);
	const search = id === 'searxng' ? searchSearxngPlaces : searchBravePlaces;
	return search(targetOf(db, id), query, fetchImpl);
}

const placeError = (e: unknown, id: PlaceProviderId) =>
	e instanceof WebSearchError || e instanceof GoogleMapsError
		? e.message
		: `${PLACE_PROVIDER_NAMES[id]}: ${e instanceof Error ? e.message : String(e)}`;

/** SearXNG searches places by name only; the others also around coordinates or without a query. */
const canSearchPlaces = (id: PlaceProviderId, q: PlaceQuery) =>
	id !== 'searxng' || isNamedPlaceQuery(q);

/**
 * Searches the best configured provider that can run the query, falling back to the
 * next when one fails or finds nothing. Finding nothing everywhere is an empty answer,
 * not an error.
 */
export async function searchPlaces(
	db: Db,
	query: PlaceQuery,
	opts: PlaceSearchOptions = {}
): Promise<PlaceSearchOutcome> {
	const configured = placeProviders(db);
	if (configured.length === 0) {
		throw new Error(
			'place search needs a Google Maps or Brave Search API key, or a SearXNG instance'
		);
	}
	const able = configured.filter((id) => canSearchPlaces(id, query));
	// None can run it: let the first say why.
	const providers = able.length ? able : configured.slice(0, 1);
	// Everything said about the providers tried so far, and just their failures.
	const notes: string[] = [];
	const failures: string[] = [];
	let emptyFrom: PlaceProviderId | undefined;
	for (const provider of providers) {
		try {
			const places = await runPlaceSearch(db, provider, query, opts);
			if (places.length) return { provider, places, errors: notes };
			emptyFrom ??= provider;
			notes.push(`${PLACE_PROVIDER_NAMES[provider]} found no places`);
		} catch (e) {
			if (query.signal?.aborted) throw e;
			const error = placeError(e, provider);
			notes.push(error);
			failures.push(error);
		}
	}
	// An empty answer still says which providers couldn't be asked.
	if (emptyFrom) return { provider: emptyFrom, places: [], errors: failures };
	// Providers left out above, e.g. SearXNG when Brave failed on a search around coordinates.
	const skipped = configured
		.filter((id) => !providers.includes(id))
		.map((id) => `${PLACE_PROVIDER_NAMES[id]} skipped (needs both query and location)`);
	throw new Error([...failures, ...skipped].join('; '));
}
