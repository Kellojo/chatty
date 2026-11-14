import { z } from 'zod';
import { config } from '../config.js';
import { decryptSecret, encryptSecret } from '../crypto.js';
import type { Db } from '../db/index.js';
import {
	clearAaModels,
	countAaModels,
	replaceAaModels,
	type AaModel
} from '../db/repo/aa-models.js';
import { deleteSetting, getSetting, setSetting } from '../db/repo/settings.js';
import { createLogger } from '../logger.js';

const log = createLogger('artificial-analysis');

export const AA_ENDPOINT = 'https://artificialanalysis.ai/api/v2/language/models/free';
/** ~200 models per page; a handful of pages covers the whole list. */
const MAX_PAGES = 5;
const KEY_SETTING = 'aa.apiKey';
const STATUS_SETTING = 'aa.status';

/** Minimum gap between fetches, per trigger. The free tier allows 100 requests a day and a
 *  refresh costs 2-3, so these only stop bursts (several providers synced in a row).
 *  Nothing refreshes on its own: only a model sync, the Refresh button or saving a key. */
const COOLDOWN_MS = {
	sync: 60 * 60 * 1000,
	manual: 10 * 60 * 1000
} as const;

export type RefreshReason = keyof typeof COOLDOWN_MS;

export interface AaStatus {
	fetchedAt: number | null;
	indexVersion: number | null;
	modelCount: number;
	lastError: string | null;
	/** No requests before this time (epoch ms), from a 429 or an exhausted quota. */
	retryAfter: number | null;
}

export interface AaKeyInfo {
	source: 'env' | 'app' | null;
	/** Last four characters, for "••••3f2a". */
	hint: string | null;
}

const pageSchema = z.object({
	intelligence_index_version: z.number().nullish(),
	pagination: z.object({ has_more: z.boolean() }).partial().nullish(),
	data: z.array(
		z.object({
			id: z.string(),
			slug: z.string(),
			name: z.string(),
			release_date: z.string().nullish(),
			model_creator: z.object({ name: z.string().nullish() }).nullish(),
			evaluations: z
				.object({ artificial_analysis_intelligence_index: z.number().nullish() })
				.passthrough()
				.nullish()
		})
	)
});

export class AaRequestError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly retryAfter: number | null = null
	) {
		super(message);
	}
}

// ── Key ──────────────────────────────────────────────────────────────────────

function storedKey(db: Db): string | null {
	const blob = getSetting<string>(db, KEY_SETTING);
	if (!blob) return null;
	try {
		return decryptSecret(blob);
	} catch {
		log.warn('Stored Artificial Analysis key could not be decrypted (APP_SECRET changed?)');
		return null;
	}
}

/** The env var wins, so Docker setups can pin the key; otherwise the one saved in the app. */
export function getApiKey(db: Db): string | null {
	return config.ARTIFICIAL_ANALYSIS_API_KEY ?? storedKey(db);
}

export function getKeyInfo(db: Db): AaKeyInfo {
	const source = config.ARTIFICIAL_ANALYSIS_API_KEY ? 'env' : storedKey(db) ? 'app' : null;
	const key = getApiKey(db);
	return { source, hint: key ? key.slice(-4) : null };
}

/** Saves a key after checking it with a real fetch, which also fills the cache. A rejected
 *  key throws and leaves the current key, cache and status untouched. */
export async function saveApiKey(db: Db, apiKey: string, fetchImpl = fetch): Promise<AaStatus> {
	const { models, indexVersion } = await fetchAaModels(apiKey, fetchImpl);
	const fetchedAt = Date.now();
	db.transaction(() => {
		replaceAaModels(db, models, fetchedAt);
		setSetting(db, KEY_SETTING, encryptSecret(apiKey));
	})();
	return saveStatus(db, { fetchedAt, indexVersion, lastError: null, retryAfter: null });
}

/** Removes the saved key with the cached scores and status, which turns the feature off. */
export function clearApiKey(db: Db): void {
	db.transaction(() => {
		deleteSetting(db, KEY_SETTING);
		deleteSetting(db, STATUS_SETTING);
		clearAaModels(db);
	})();
}

// ── Status ───────────────────────────────────────────────────────────────────

export function getStatus(db: Db): AaStatus {
	const saved = getSetting<Partial<AaStatus>>(db, STATUS_SETTING) ?? {};
	return {
		fetchedAt: saved.fetchedAt ?? null,
		indexVersion: saved.indexVersion ?? null,
		modelCount: countAaModels(db),
		lastError: saved.lastError ?? null,
		retryAfter: saved.retryAfter ?? null
	};
}

function saveStatus(db: Db, patch: Partial<AaStatus>): AaStatus {
	const current = getStatus(db);
	const next = { ...current, ...patch };
	setSetting(db, STATUS_SETTING, {
		fetchedAt: next.fetchedAt,
		indexVersion: next.indexVersion,
		lastError: next.lastError,
		retryAfter: next.retryAfter
	});
	return getStatus(db);
}

// ── Fetching ─────────────────────────────────────────────────────────────────

function retryAfterFrom(res: Response, now: number): number | null {
	const header = res.headers.get('retry-after');
	if (header && Number.isFinite(Number(header))) return now + Number(header) * 1000;
	const reset = Number(res.headers.get('x-ratelimit-reset'));
	return Number.isFinite(reset) && reset > 0 ? reset * 1000 : null;
}

/** Fetches every page of the free model list. Throws `AaRequestError` on HTTP errors. */
export async function fetchAaModels(
	apiKey: string,
	fetchImpl = fetch
): Promise<{ models: AaModel[]; indexVersion: number | null }> {
	const models: AaModel[] = [];
	let indexVersion: number | null = null;
	for (let page = 1; page <= MAX_PAGES; page++) {
		const res = await fetchImpl(`${AA_ENDPOINT}?page=${page}`, {
			headers: { 'x-api-key': apiKey, accept: 'application/json' },
			signal: AbortSignal.timeout(20_000)
		});
		if (!res.ok) {
			const message =
				res.status === 401 || res.status === 403
					? 'Artificial Analysis rejected the API key'
					: res.status === 429
						? 'Artificial Analysis rate limit reached'
						: `Artificial Analysis request failed (${res.status})`;
			throw new AaRequestError(
				message,
				res.status,
				res.status === 429 ? retryAfterFrom(res, Date.now()) : null
			);
		}
		const parsed = pageSchema.safeParse(await res.json());
		if (!parsed.success)
			throw new AaRequestError('Unexpected response from Artificial Analysis', 502);
		indexVersion = parsed.data.intelligence_index_version ?? indexVersion;
		for (const m of parsed.data.data) {
			models.push({
				id: m.id,
				slug: m.slug,
				name: m.name,
				creator: m.model_creator?.name ?? null,
				intelligenceIndex: m.evaluations?.artificial_analysis_intelligence_index ?? null,
				releaseDate: m.release_date ?? null
			});
		}
		if (!parsed.data.pagination?.has_more) break;
	}
	return { models, indexVersion };
}

async function runRefresh(db: Db, apiKey: string, fetchImpl = fetch): Promise<AaStatus> {
	try {
		const { models, indexVersion } = await fetchAaModels(apiKey, fetchImpl);
		const fetchedAt = Date.now();
		replaceAaModels(db, models, fetchedAt);
		log.info(`Fetched ${models.length} Artificial Analysis models`);
		return saveStatus(db, { fetchedAt, indexVersion, lastError: null, retryAfter: null });
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		log.warn('Artificial Analysis refresh failed', { error: message });
		return saveStatus(db, {
			lastError: message,
			retryAfter: e instanceof AaRequestError ? e.retryAfter : null
		});
	}
}

let inflight: Promise<AaStatus> | null = null;

export type RefreshOutcome =
	| { state: 'updated' | 'failed'; status: AaStatus }
	| { state: 'skipped'; reason: 'no-key' | 'cooldown' | 'rate-limited'; status: AaStatus };

/**
 * Refreshes the cache unless that would be wasteful: no key, still rate-limited, or fetched
 * within the trigger's cooldown. A refresh already running is joined, never duplicated.
 */
export async function refreshScores(
	db: Db,
	reason: RefreshReason,
	fetchImpl = fetch
): Promise<RefreshOutcome> {
	if (inflight) {
		const status = await inflight;
		return { state: status.lastError ? 'failed' : 'updated', status };
	}
	const status = getStatus(db);
	const apiKey = getApiKey(db);
	if (!apiKey) return { state: 'skipped', reason: 'no-key', status };
	const now = Date.now();
	if (status.retryAfter && status.retryAfter > now) {
		return { state: 'skipped', reason: 'rate-limited', status };
	}
	if (status.fetchedAt && now - status.fetchedAt < COOLDOWN_MS[reason]) {
		return { state: 'skipped', reason: 'cooldown', status };
	}
	inflight = runRefresh(db, apiKey, fetchImpl);
	try {
		const next = await inflight;
		return { state: next.lastError ? 'failed' : 'updated', status: next };
	} finally {
		inflight = null;
	}
}

/** Test hook: forget a refresh left running by a previous test. */
export function _resetForTests(): void {
	inflight = null;
}
