import { resolveProviderBrand } from '$lib/provider-brand.js';
import { decryptSecret } from '../crypto.js';
import { getDb } from '../db/index.js';
import { findModel } from '../db/repo/models.js';
import { getProvider, type ProviderRow } from '../db/repo/providers.js';

/**
 * LM Studio's native REST API reports, per model, the context length it is
 * actually loaded with. That, not the model's trained maximum, is what a prompt
 * has to fit, so compaction asks for it live (the user can reload a model with a
 * different context at any time).
 */

const CACHE_TTL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 2_000;

export interface LmStudioModel {
	id: string;
	maxContextLength: number | null;
	/** Smallest context among the loaded instances; null when not loaded. */
	loadedContextLength: number | null;
}

export function isLmStudioProvider(provider: ProviderRow): boolean {
	return (
		provider.type === 'openai-compatible' &&
		resolveProviderBrand({
			name: provider.name,
			baseUrl: provider.base_url,
			type: provider.type
		}) === 'lmstudio'
	);
}

/** The server root: the OpenAI base URL without its `/v1` suffix. */
function serverRoot(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
}

function positiveInt(value: unknown): number | null {
	const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function minOf(values: (number | null)[]): number | null {
	const known = values.filter((v): v is number => v !== null);
	return known.length > 0 ? Math.min(...known) : null;
}

/** `/api/v1/models` (LM Studio 0.4+). */
function parseV1(body: unknown): LmStudioModel[] | null {
	const models = (body as { models?: unknown } | null)?.models;
	if (!Array.isArray(models)) return null;
	return models.flatMap((m) => {
		const key = (m as { key?: unknown }).key;
		if (typeof key !== 'string') return [];
		const instances = (m as { loaded_instances?: unknown }).loaded_instances;
		const loaded = Array.isArray(instances)
			? instances.map((i) =>
					positiveInt((i as { config?: { context_length?: unknown } })?.config?.context_length)
				)
			: [];
		return [
			{
				id: key,
				maxContextLength: positiveInt((m as { max_context_length?: unknown }).max_context_length),
				loadedContextLength: minOf(loaded)
			}
		];
	});
}

/** `/api/v0/models` (older LM Studio builds). */
function parseV0(body: unknown): LmStudioModel[] | null {
	const data = (body as { data?: unknown } | null)?.data;
	if (!Array.isArray(data)) return null;
	return data.flatMap((m) => {
		const row = m as {
			id?: unknown;
			state?: unknown;
			max_context_length?: unknown;
			loaded_context_length?: unknown;
		};
		if (typeof row.id !== 'string') return [];
		return [
			{
				id: row.id,
				maxContextLength: positiveInt(row.max_context_length),
				loadedContextLength: row.state === 'loaded' ? positiveInt(row.loaded_context_length) : null
			}
		];
	});
}

/** Lists the server's models, or null when it isn't reachable or isn't LM Studio. */
export async function fetchLmStudioModels(provider: ProviderRow): Promise<LmStudioModel[] | null> {
	if (!provider.base_url) return null;
	const root = serverRoot(provider.base_url);
	const headers: Record<string, string> = {};
	const apiKey = provider.api_key_enc ? decryptSecret(provider.api_key_enc) : undefined;
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
	for (const [path, parse] of [
		['/api/v1/models', parseV1],
		['/api/v0/models', parseV0]
	] as const) {
		try {
			const res = await fetch(`${root}${path}`, {
				headers,
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
			});
			if (!res.ok) continue;
			const models = parse(await res.json());
			if (models) return models;
		} catch {
			// unreachable or not LM Studio: try the next endpoint
		}
	}
	return null;
}

const cache = new Map<string, { at: number; models: Promise<LmStudioModel[] | null> }>();

/**
 * The context length `modelId` is loaded with on an LM Studio provider, or null
 * when the provider isn't LM Studio, the model isn't loaded, or the server
 * doesn't answer. Cached per provider for a short while.
 */
export async function liveContextLength(
	provider: ProviderRow,
	modelId: string
): Promise<number | null> {
	if (!isLmStudioProvider(provider)) return null;
	const now = Date.now();
	let hit = cache.get(provider.id);
	if (!hit || now - hit.at > CACHE_TTL_MS) {
		hit = { at: now, models: fetchLmStudioModels(provider) };
		cache.set(provider.id, hit);
	}
	const models = await hit.models;
	return models?.find((m) => m.id === modelId)?.loadedContextLength ?? null;
}

/**
 * The context window to budget a prompt against: what an LM Studio model is
 * loaded with right now when the server says so, else the stored value.
 */
export async function effectiveContextLength(ref: {
	providerId: string;
	modelId: string;
}): Promise<number | null> {
	const db = getDb();
	const stored = findModel(db, ref.providerId, ref.modelId)?.context_length ?? null;
	const provider = getProvider(db, ref.providerId);
	if (!provider) return stored;
	return (await liveContextLength(provider, ref.modelId)) ?? stored;
}
