import type { ModelMappingTarget } from '$lib/types.js';
import type { Db } from '../db/index.js';
import { findModel } from '../db/repo/models.js';
import { getProvider } from '../db/repo/providers.js';
import { decryptSecret } from '../crypto.js';
import { ModelUnavailableError } from '../llm/mapped.js';

/** Where to send an OpenAI-style audio request for one target. */
export interface AudioEndpoint {
	baseUrl: string;
	headers: Record<string, string>;
	providerName: string;
}

/**
 * The endpoint for `target` if its provider and model are enabled and the model
 * has `capability`; otherwise throws ModelUnavailableError so callers try the next target.
 */
export function resolveAudioEndpoint(
	db: Db,
	target: ModelMappingTarget,
	capability: 'transcription' | 'speech',
	feature: string
): AudioEndpoint {
	const provider = getProvider(db, target.providerId);
	if (!provider || provider.enabled !== 1) {
		throw new ModelUnavailableError(`Provider ${target.providerId} is not available`);
	}

	const model = findModel(db, target.providerId, target.modelId);
	if (!model || model.enabled !== 1) {
		throw new ModelUnavailableError(`Model ${target.modelId} is not available`);
	}

	const caps = JSON.parse(model.capabilities) as string[];
	if (!caps.includes(capability)) {
		throw new ModelUnavailableError(`Model ${target.modelId} does not support ${feature}`);
	}

	if (provider.type === 'anthropic') {
		throw new ModelUnavailableError(`Provider "${provider.name}" does not expose a ${feature} API`);
	}

	if (!provider.base_url) {
		throw new ModelUnavailableError(`Provider "${provider.name}" is missing a base URL`);
	}

	const apiKey = provider.api_key_enc ? decryptSecret(provider.api_key_enc) : undefined;
	const headers: Record<string, string> = {};
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
	return { baseUrl: provider.base_url.replace(/\/$/, ''), headers, providerName: provider.name };
}

/** The message of an upstream error response: OpenAI's `error.message`, else the raw body. */
export async function upstreamErrorMessage(res: Response): Promise<string> {
	const raw = await res.text().catch(() => 'Unknown error');
	try {
		const parsed = JSON.parse(raw) as { error?: { message?: string } };
		if (parsed.error?.message) return parsed.error.message;
	} catch {
		/* not JSON, use raw text */
	}
	return raw;
}

/**
 * How Chatty passes on a provider's error. A provider refusing Chatty's own key
 * (401/403) becomes a 502, so callers don't take it for their session or key failing.
 */
export function relayUpstreamError(
	status: number,
	message: string
): { status: number; message: string } {
	if (status === 401 || status === 403) {
		return { status: 502, message: `Provider rejected the request: ${message}` };
	}
	return { status: status >= 400 && status < 600 ? status : 502, message };
}
