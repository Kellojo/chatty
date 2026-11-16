import type { ModelMappingTarget, RequestSource } from '$lib/types.js';
import { getDb } from '../db/index.js';
import { createProxyRequest, finalizeProxyRequest } from '../db/repo/proxy-requests.js';
import { resolveRefTargets } from '../llm/mapped.js';
import { createLogger } from '../logger.js';
import { filterTargets, type Privacy } from '../privacy/policy.js';
import { resolveAudioEndpoint, upstreamErrorMessage } from './targets.js';

const log = createLogger('speech');

export class TranscriptionError extends Error {
	constructor(
		public status: number,
		message: string
	) {
		super(message);
	}
}

export interface TranscriptionOptions {
	language?: string;
	prompt?: string;
	responseFormat?: 'json' | 'text' | 'srt' | 'vtt' | 'verbose_json';
	temperature?: number;
	/** The upload's name; providers read the audio format from its extension. */
	fileName?: string;
	/** The upload's media type. */
	mimeType?: string;
}

/**
 * Tries each target in order (a model mapping's primary, then its fallbacks)
 * and reports which one served the request.
 */
export async function transcribeWithFallbacks(
	buffer: ArrayBuffer,
	mappingTargets: ModelMappingTarget[],
	privacy: Privacy,
	options?: TranscriptionOptions
): Promise<{ result: { text: string } | string; index: number; target: ModelMappingTarget }> {
	const db = getDb();
	// Any error falls back, so a private recording must never have an untrusted target to fall to.
	const targets = filterTargets(db, mappingTargets, privacy);
	if (targets.length === 0 && mappingTargets.length > 0) {
		throw new TranscriptionError(
			403,
			'This chat is private and no speech-to-text model may process private data'
		);
	}
	let lastError: unknown = null;

	for (let i = 0; i < targets.length; i++) {
		const target = targets[i];
		try {
			const { baseUrl, headers } = resolveAudioEndpoint(
				db,
				target,
				'transcription',
				'transcription',
				privacy
			);

			const formData = new FormData();
			formData.append('model', target.modelId);
			formData.append(
				'file',
				new Blob([buffer], { type: options?.mimeType || 'audio/webm' }),
				options?.fileName || 'recording.webm'
			);
			if (options?.language) formData.append('language', options.language);
			if (options?.prompt) formData.append('prompt', options.prompt);
			if (options?.responseFormat) formData.append('response_format', options.responseFormat);
			if (options?.temperature != null) formData.append('temperature', String(options.temperature));

			log.info('Transcription request', {
				providerId: target.providerId,
				modelId: target.modelId,
				baseUrl
			});

			const res = await fetch(`${baseUrl}/audio/transcriptions`, {
				method: 'POST',
				headers,
				body: formData
			});

			if (!res.ok) throw new TranscriptionError(res.status, await upstreamErrorMessage(res));

			const result =
				options?.responseFormat === 'text'
					? await res.text()
					: ((await res.json()) as { text: string });
			return { result, index: i, target };
		} catch (e) {
			lastError = e;
		}
	}

	if (lastError instanceof TranscriptionError) throw lastError;
	throw new TranscriptionError(
		502,
		lastError instanceof Error ? lastError.message : 'Transcription failed'
	);
}

/**
 * Transcribes `buffer` with `ref` (a model or a mapping), logged with the other
 * model calls (Usage → Requests) for `userId`. Returns the transcript text.
 */
export async function transcribeLogged(
	buffer: ArrayBuffer,
	ref: { providerId: string; modelId: string },
	log: {
		userId: string;
		source: RequestSource;
		conversationId?: string | null;
		runId?: string | null;
	},
	privacy: Privacy,
	options?: TranscriptionOptions
): Promise<string> {
	const db = getDb();
	const row = createProxyRequest(db, {
		userId: log.userId,
		source: log.source,
		purpose: 'transcription',
		endpoint: 'audio.transcriptions',
		requestedModel: ref.modelId,
		stream: false,
		conversationId: log.conversationId ?? null,
		runId: log.runId ?? null
	});
	const startedAt = Date.now();
	let mappingId: string | null = null;
	try {
		const resolved = resolveRefTargets(ref, db);
		mappingId = resolved.mappingId;
		const { result, index, target } = await transcribeWithFallbacks(
			buffer,
			resolved.targets,
			privacy,
			options
		);
		finalizeProxyRequest(db, row.id, {
			status: 'complete',
			httpStatus: 200,
			latencyMs: Date.now() - startedAt,
			mappingId,
			providerId: target.providerId,
			modelId: target.modelId,
			fallbackIndex: index
		});
		return typeof result === 'string' ? result : result.text;
	} catch (e) {
		finalizeProxyRequest(db, row.id, {
			status: 'failed',
			httpStatus: e instanceof TranscriptionError ? e.status : 500,
			latencyMs: Date.now() - startedAt,
			mappingId,
			error: e instanceof Error ? e.message : String(e)
		});
		throw e;
	}
}
