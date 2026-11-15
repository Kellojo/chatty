import type { ModelMappingTarget } from '$lib/types.js';
import type { Db } from '../db/index.js';
import { getDb } from '../db/index.js';
import { getSetting, setSetting, deleteSetting } from '../db/repo/settings.js';
import { ModelUnavailableError } from '../llm/mapped.js';
import { createLogger } from '../logger.js';
import { resolveAudioEndpoint, upstreamErrorMessage } from './targets.js';
import { listVoices, pickVoice } from './voices.js';

const log = createLogger('speech');

/** Used when no voice is set and the target's voices can't be determined. */
export const FALLBACK_VOICE = 'alloy';

/** OpenAI's input limit for /audio/speech; most compatible servers follow it. */
export const MAX_SPEECH_INPUT = 4096;

/** How long a provider may take to return the whole audio. */
const UPSTREAM_TIMEOUT = 120_000;

export const SPEECH_FORMATS = ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'] as const;
export type SpeechFormat = (typeof SPEECH_FORMATS)[number];

const VOICE_SETTING = 'tts.voice';

export class SpeechError extends Error {
	constructor(
		public status: number,
		message: string,
		/** The provider answered with this error (vs. Chatty refusing the request itself). */
		public upstream = true
	) {
		super(message);
	}
}

export interface SpeechOptions {
	voice?: string;
	responseFormat?: SpeechFormat;
	speed?: number;
	/** Style guidance, for models that take it (e.g. gpt-4o-mini-tts). */
	instructions?: string;
	/** Aborts the provider request, e.g. when the caller disconnects; no fallbacks are tried then. */
	signal?: AbortSignal;
}

/** The voice set in Settings → Defaults, or '' when unset. */
export function getDefaultVoice(db: Db): string {
	const voice = getSetting<unknown>(db, VOICE_SETTING);
	return typeof voice === 'string' ? voice : '';
}

export function setDefaultVoice(db: Db, voice: string): void {
	const trimmed = voice.trim();
	if (trimmed) setSetting(db, VOICE_SETTING, trimmed);
	else deleteSetting(db, VOICE_SETTING);
}

/**
 * A failure worth trying the next target for: the provider is down, busy, slow or
 * refuses Chatty's key. Other 4xx answers are about the request, so every target would refuse it.
 */
function isRetryable(e: unknown): boolean {
	if (!(e instanceof SpeechError)) return true;
	return e.status >= 500 || [401, 403, 408, 429].includes(e.status);
}

/**
 * Synthesizes `input` via a provider's /audio/speech endpoint, trying each target
 * in order (a model mapping's primary, then its fallbacks). The audio is read in
 * full (input is at most MAX_SPEECH_INPUT chars), so a request only counts as
 * served once all of it arrived.
 */
export async function synthesizeWithFallbacks(
	input: string,
	targets: ModelMappingTarget[],
	options?: SpeechOptions
): Promise<{
	audio: ArrayBuffer;
	contentType: string;
	index: number;
	target: ModelMappingTarget;
}> {
	const db = getDb();
	const requestedVoice = options?.voice?.trim() || undefined;
	const configuredVoice = getDefaultVoice(db);
	const responseFormat = options?.responseFormat ?? 'mp3';
	let lastError: unknown = null;

	for (let i = 0; i < targets.length; i++) {
		const target = targets[i];
		try {
			const { baseUrl, headers, providerName } = resolveAudioEndpoint(
				db,
				target,
				'speech',
				'text-to-speech'
			);
			// Checked per target: a mapping's fallbacks may use different voice names.
			const voice = pickVoice(
				requestedVoice,
				configuredVoice,
				await listVoices(db, target),
				FALLBACK_VOICE
			);

			log.info('Speech request', {
				providerId: target.providerId,
				modelId: target.modelId,
				baseUrl,
				chars: input.length,
				voice
			});

			const timeout = AbortSignal.timeout(UPSTREAM_TIMEOUT);
			const signal = options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
			const reachError = (e: unknown) => {
				const reason = timeout.aborted
					? 'timed out'
					: options?.signal?.aborted
						? 'request was cancelled'
						: e instanceof Error
							? e.message
							: String(e);
				return new SpeechError(502, `Could not reach provider "${providerName}": ${reason}`);
			};
			const res = await fetch(`${baseUrl}/audio/speech`, {
				signal,
				method: 'POST',
				headers: { ...headers, 'content-type': 'application/json' },
				body: JSON.stringify({
					model: target.modelId,
					input,
					voice,
					response_format: responseFormat,
					...(options?.speed != null ? { speed: options.speed } : {}),
					...(options?.instructions ? { instructions: options.instructions } : {})
				})
			}).catch((e: unknown) => {
				throw reachError(e);
			});

			if (!res.ok) throw new SpeechError(res.status, await upstreamErrorMessage(res));
			const audio = await res.arrayBuffer().catch((e: unknown) => {
				throw reachError(e);
			});
			if (audio.byteLength === 0) throw new SpeechError(502, 'Provider returned no audio');

			return {
				audio,
				contentType: res.headers.get('content-type') || audioContentType(responseFormat),
				index: i,
				target
			};
		} catch (e) {
			if (options?.signal?.aborted || !isRetryable(e)) throw e;
			lastError = e;
		}
	}

	if (lastError instanceof SpeechError) throw lastError;
	if (lastError instanceof ModelUnavailableError)
		throw new SpeechError(400, lastError.message, false);
	throw new SpeechError(502, lastError instanceof Error ? lastError.message : 'Speech failed');
}

function audioContentType(format: SpeechFormat): string {
	switch (format) {
		case 'mp3':
			return 'audio/mpeg';
		case 'opus':
			return 'audio/ogg';
		case 'aac':
			return 'audio/aac';
		case 'flac':
			return 'audio/flac';
		case 'wav':
			return 'audio/wav';
		case 'pcm':
			return 'audio/pcm';
	}
}
