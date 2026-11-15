import type { ModelMappingTarget } from '$lib/types.js';
import type { Db } from '../db/index.js';
import { findModel, findRoleModel, modelVoices } from '../db/repo/models.js';
import { getProvider } from '../db/repo/providers.js';
import { resolveRefTargets } from '../llm/mapped.js';
import { createLogger } from '../logger.js';
import { resolveAudioEndpoint } from './targets.js';

const log = createLogger('speech');

/** The voices a text-to-speech target accepts, and the one it uses by default. */
export interface VoiceList {
	voices: string[];
	/** The provider's own default, when it names one. */
	defaultVoice: string | null;
}

/**
 * How long a provider's `/audio/voices` answer is remembered. A failed lookup is
 * retried soon: a local server that is starting up or loading a model answers slowly.
 */
const PROBE_TTL = 10 * 60_000;
const FAILED_PROBE_TTL = 30_000;
const PROBE_TIMEOUT = 5_000;
const probes = new Map<string, { at: number; ttl: number; list: Promise<VoiceList | null> }>();

/** Forgets probed voice lists, e.g. after a provider changes. */
export function clearVoiceCache(): void {
	probes.clear();
}

/**
 * The voices `target` accepts, or null when they can't be determined. A model's
 * synced list (OpenRouter's `supported_voices`, Speaches' `voices`) wins; otherwise the provider is
 * asked via `GET /audio/voices`, which Kokoro-FastAPI and compatible servers serve.
 */
export async function listVoices(db: Db, target: ModelMappingTarget): Promise<VoiceList | null> {
	const model = findModel(db, target.providerId, target.modelId);
	const synced = model ? modelVoices(model) : null;
	if (synced) return { voices: synced, defaultVoice: null };

	const provider = getProvider(db, target.providerId);
	if (!provider || provider.type === 'anthropic' || !provider.base_url) return null;

	const cached = probes.get(provider.id);
	if (cached && Date.now() - cached.at < cached.ttl) return cached.list;
	let endpoint: { baseUrl: string; headers: Record<string, string> };
	try {
		endpoint = resolveAudioEndpoint(db, target, 'speech', 'text-to-speech');
	} catch {
		return null;
	}
	const entry = {
		at: Date.now(),
		ttl: PROBE_TTL,
		list: probeVoices(endpoint.baseUrl, endpoint.headers)
	};
	probes.set(provider.id, entry);
	const list = await entry.list;
	if (!list) entry.ttl = FAILED_PROBE_TTL;
	return list;
}

/**
 * The voices of the Text to speech default (a mapping's primary target), or null
 * when none is set or its voices can't be determined.
 */
export async function roleVoices(db: Db): Promise<VoiceList | null> {
	const role = findRoleModel(db, 'text-to-speech');
	if (!role) return null;
	try {
		const { targets } = resolveRefTargets(
			{ providerId: role.provider_id, modelId: role.model_id },
			db
		);
		return targets[0] ? await listVoices(db, targets[0]) : null;
	} catch {
		return null;
	}
}

async function probeVoices(
	baseUrl: string,
	headers: Record<string, string>
): Promise<VoiceList | null> {
	try {
		const res = await fetch(`${baseUrl}/audio/voices`, {
			headers,
			signal: AbortSignal.timeout(PROBE_TIMEOUT)
		});
		if (!res.ok) return null;
		return parseVoiceList(await res.json());
	} catch (e) {
		log.info('No voice list', { baseUrl, error: e instanceof Error ? e.message : String(e) });
		return null;
	}
}

/**
 * Reads a `/audio/voices` answer: `{ voices: ["af_bella", …] }` or
 * `{ voices: [{ id: "af_bella", … }], default_voice: "af_heart" }`.
 */
export function parseVoiceList(body: unknown): VoiceList | null {
	if (!body || typeof body !== 'object') return null;
	const voices = voiceNames((body as { voices?: unknown }).voices);
	if (!voices) return null;
	const named = (body as { default_voice?: unknown }).default_voice;
	const defaultVoice = typeof named === 'string' && voices.includes(named) ? named : null;
	return { voices, defaultVoice };
}

/**
 * The voice to send to a target. A voice the caller asked for is sent as is (the
 * list may not cover blends or custom voices); the configured default is used
 * when the target accepts it, else the target's own default. `null` = unknown list.
 */
export function pickVoice(
	requested: string | undefined,
	configured: string,
	list: VoiceList | null,
	fallback: string
): string {
	if (requested) return requested;
	if (!list) return configured || fallback;
	if (configured && list.voices.includes(configured)) return configured;
	return list.defaultVoice ?? (list.voices.includes(fallback) ? fallback : list.voices[0]);
}

/**
 * Voice names from a model listing: plain strings (OpenRouter's `supported_voices`)
 * or `{ id }` objects (Speaches' `voices`). Undefined when the listing has none.
 */
export function voiceNames(raw: unknown): string[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const names = raw
		.map((v) =>
			typeof v === 'string' ? v : v && typeof v === 'object' ? (v as { id?: unknown }).id : null
		)
		.filter((v): v is string => typeof v === 'string' && v.length > 0);
	return names.length ? names : undefined;
}
