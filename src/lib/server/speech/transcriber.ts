import { getDb } from '../db/index.js';
import { findModel } from '../db/repo/models.js';
import { getProvider } from '../db/repo/providers.js';
import { decryptSecret } from '../crypto.js';
import { ModelUnavailableError, resolveRefTargets } from '../llm/mapped.js';
import { createLogger } from '../logger.js';

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
}

/**
 * Transcribe audio via a provider's /audio/transcriptions endpoint.
 * Returns text or the raw JSON response depending on responseFormat.
 */
export async function transcribeAudio(
	buffer: ArrayBuffer,
	providerId: string,
	modelId: string,
	options?: TranscriptionOptions
): Promise<{ text: string } | string> {
	const db = getDb();

	const resolved = resolveRefTargets({ providerId, modelId }, db);

	let lastError: unknown = null;

	for (let i = 0; i < resolved.targets.length; i++) {
		const target = resolved.targets[i];
		const provider = getProvider(db, target.providerId);
		if (!provider || provider.enabled !== 1) {
			lastError = new ModelUnavailableError(`Provider ${target.providerId} is not available`);
			continue;
		}

		const model = findModel(db, target.providerId, target.modelId);
		if (!model || model.enabled !== 1) {
			lastError = new ModelUnavailableError(`Model ${target.modelId} is not available`);
			continue;
		}

		const caps = JSON.parse(model.capabilities) as string[];
		if (!caps.includes('transcription')) {
			lastError = new ModelUnavailableError(
				`Model ${target.modelId} does not support transcription`
			);
			continue;
		}

		if (provider.type === 'anthropic') {
			lastError = new ModelUnavailableError(
				`Provider "${provider.name}" does not expose a transcription API`
			);
			continue;
		}

		if (!provider.base_url) {
			lastError = new ModelUnavailableError(`Provider "${provider.name}" is missing a base URL`);
			continue;
		}

		const apiKey = provider.api_key_enc ? decryptSecret(provider.api_key_enc) : undefined;
		const baseUrl = provider.base_url.replace(/\/$/, '');

		try {
			const formData = new FormData();
			formData.append('model', target.modelId);
			formData.append('file', new Blob([buffer], { type: 'audio/webm' }), 'recording.webm');
			if (options?.language) formData.append('language', options.language);
			if (options?.prompt) formData.append('prompt', options.prompt);
			if (options?.responseFormat) formData.append('response_format', options.responseFormat);
			if (options?.temperature != null) formData.append('temperature', String(options.temperature));

			const headers: Record<string, string> = {};
			if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

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

			if (!res.ok) {
				const raw = await res.text().catch(() => 'Unknown error');
				let message = raw;
				try {
					const parsed = JSON.parse(raw) as { error?: { message?: string } };
					if (parsed.error?.message) message = parsed.error.message;
				} catch {
					/* not JSON, use raw text */
				}
				throw new TranscriptionError(res.status, message);
			}

			if (options?.responseFormat === 'text') {
				return await res.text();
			}

			const json = (await res.json()) as { text: string };
			return json;
		} catch (e) {
			lastError = e;
			if (i < resolved.targets.length - 1) continue;
		}
	}

	if (lastError instanceof TranscriptionError) throw lastError;
	throw new TranscriptionError(
		502,
		lastError instanceof Error ? lastError.message : 'Transcription failed'
	);
}
