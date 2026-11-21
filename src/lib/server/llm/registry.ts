import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { ImageModel, LanguageModel } from 'ai';
import { fetchLmStudioModels, isLmStudioProvider } from './lmstudio.js';
import { createOpenRouterImageModel } from './openrouterImage.js';
import { decryptSecret } from '../crypto.js';
import { getDb } from '../db/index.js';
import {
	findModel,
	findRoleModel,
	listEnabledModels,
	toPublic as modelToPublic,
	type ChatModel,
	type FetchedModel,
	type ModelRole
} from '../db/repo/models.js';
import {
	getProvider,
	listProviders,
	toPublic as providerToPublic,
	type Provider,
	type ProviderRow
} from '../db/repo/providers.js';
import { voiceNames } from '../speech/voices.js';
import { assertModelAllowed, type Privacy } from '../privacy/policy.js';

type LanguageModelFactory = (modelId: string) => LanguageModel;

/**
 * The AI SDK provider name a provider row is registered under. Also the key
 * its `providerOptions` / `providerMetadata` entries use.
 */
export function providerSlug(provider: Pick<ProviderRow, 'name'>): string {
	return provider.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

const cache = new Map<string, { signature: string; factory: LanguageModelFactory }>();

function buildFactory(provider: ProviderRow): LanguageModelFactory {
	const apiKey = provider.api_key_enc ? decryptSecret(provider.api_key_enc) : undefined;
	if (provider.type === 'anthropic') {
		const p = createAnthropic({ apiKey, baseURL: provider.base_url ?? undefined });
		return (modelId) => p(modelId);
	}
	if (!provider.base_url) {
		throw new Error(`Provider "${provider.name}" is missing a base URL`);
	}
	const p = createOpenAICompatible({
		name: providerSlug(provider),
		apiKey,
		baseURL: provider.base_url,
		includeUsage: true,
		// Without this the SDK downgrades a `json_schema` response format to
		// plain `json_object`, dropping the schema proxy clients ask for.
		supportsStructuredOutputs: true
	});
	return (modelId) => p(modelId);
}

function factoryFor(provider: ProviderRow): LanguageModelFactory {
	const signature = [provider.type, provider.name, provider.base_url, provider.api_key_enc].join(
		'|'
	);
	const hit = cache.get(provider.id);
	if (hit && hit.signature === signature) return hit.factory;
	const factory = buildFactory(provider);
	cache.set(provider.id, { signature, factory });
	return factory;
}

export function invalidateProviderCache(providerId: string): void {
	cache.delete(providerId);
}

function isOpenRouter(provider: Pick<ProviderRow, 'type' | 'base_url'>): boolean {
	return (
		provider.type === 'openai-compatible' &&
		(provider.base_url ?? '').replace(/\/$/, '').endsWith('openrouter.ai/api/v1')
	);
}

function buildImageFactory(provider: ProviderRow): (modelId: string) => ImageModel {
	const apiKey = provider.api_key_enc ? decryptSecret(provider.api_key_enc) : undefined;
	if (provider.type === 'anthropic') {
		throw new ModelUnavailableError(
			`Provider "${provider.name}" does not support image generation`
		);
	}
	if (!provider.base_url) {
		throw new Error(`Provider "${provider.name}" is missing a base URL`);
	}
	if (isOpenRouter(provider)) {
		return (modelId) =>
			createOpenRouterImageModel({
				provider: providerSlug(provider),
				modelId,
				baseURL: provider.base_url!,
				apiKey
			});
	}
	const p = createOpenAICompatible({
		name: providerSlug(provider),
		apiKey,
		baseURL: provider.base_url
	});
	return (modelId) => p.imageModel(modelId);
}

/**
 * The image model for `ref`. `privacy` is the context the prompt comes from:
 * a private one may only use a provider trusted with private data.
 */
export function resolveImageModel(
	ref: { providerId: string; modelId: string },
	privacy: Privacy
): ImageModel {
	const db = getDb();
	assertModelAllowed(db, ref, privacy);
	const provider = getProvider(db, ref.providerId);
	if (!provider || provider.enabled !== 1) {
		throw new ModelUnavailableError(`Provider ${ref.providerId} is not available`);
	}
	const model = findModel(db, ref.providerId, ref.modelId);
	if (!model || model.enabled !== 1) {
		throw new ModelUnavailableError(`Model ${ref.modelId} is not available`);
	}
	return buildImageFactory(provider)(ref.modelId);
}

export { ModelUnavailableError } from './mapped.js';
import { ModelUnavailableError, resolveRefTargets } from './mapped.js';

/**
 * The language model for `ref`. `privacy` is the context the prompt comes
 * from: a private one may only use a provider trusted with private data
 * (throws PrivateDataBlockedError otherwise, before any request).
 */
export function resolveModel(
	ref: { providerId: string; modelId: string },
	privacy: Privacy
): LanguageModel {
	const db = getDb();
	assertModelAllowed(db, ref, privacy);
	const provider = getProvider(db, ref.providerId);
	if (!provider || provider.enabled !== 1) {
		throw new ModelUnavailableError(`Provider ${ref.providerId} is not available`);
	}
	const model = findModel(db, ref.providerId, ref.modelId);
	if (!model || model.enabled !== 1) {
		throw new ModelUnavailableError(`Model ${ref.modelId} is not available`);
	}
	return factoryFor(provider)(ref.modelId);
}

export function roleModel(role: ModelRole, privacy: Privacy): LanguageModel {
	const db = getDb();
	const model = findRoleModel(db, role);
	if (!model) {
		throw new ModelUnavailableError(`No enabled default model configured for role "${role}"`);
	}
	return resolveModel(
		resolveRefTargets({ providerId: model.provider_id, modelId: model.model_id }, db).targets[0],
		privacy
	);
}

export interface ModelsByProvider {
	provider: Provider;
	models: ChatModel[];
}

export function listModelsGrouped(): ModelsByProvider[] {
	const db = getDb();
	const providers = listProviders(db).filter((p) => p.enabled === 1);
	const models = listEnabledModels(db);
	return providers
		.map((p) => ({
			provider: providerToPublic(p),
			models: models.filter((m) => m.provider_id === p.id).map(modelToPublic)
		}))
		.filter((g) => g.models.length > 0);
}

// Anthropic's /v1/models doesn't expose context windows; all current Claude
// models are 200k. Override per-model in settings if this ever diverges.
const ANTHROPIC_CONTEXT_LENGTH = 200_000;

async function fetchAnthropicModels(
	provider: ProviderFetchConfig,
	apiKey: string | undefined
): Promise<FetchedModel[]> {
	if (!apiKey) throw new Error(`Provider "${provider.name}" requires an API key to list models`);
	const base = provider.base_url ?? 'https://api.anthropic.com';
	const res = await fetch(`${base}/v1/models?limit=1000`, {
		headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
	});
	if (!res.ok) throw new Error(`Anthropic /models probe failed: ${res.status} ${await res.text()}`);
	const body = (await res.json()) as { data?: { id: string }[] };
	return (body.data ?? []).map((m) => ({ id: m.id, contextLength: ANTHROPIC_CONTEXT_LENGTH }));
}

function pricePerMillion(value: unknown): number | null {
	if (typeof value !== 'string' && typeof value !== 'number') return null;
	const perToken = Number(value);
	if (!Number.isFinite(perToken) || perToken <= 0) return null;
	return perToken * 1_000_000;
}

function contextLength(m: {
	context_length?: unknown;
	top_provider?: { context_length?: unknown };
}): number | null {
	for (const value of [m.context_length, m.top_provider?.context_length]) {
		if (typeof value !== 'number' && typeof value !== 'string') continue;
		const n = Number(value);
		if (Number.isFinite(n) && n > 0) return Math.floor(n);
	}
	return null;
}

async function fetchOpenAICompatibleModels(
	provider: ProviderFetchConfig,
	apiKey: string | undefined
): Promise<FetchedModel[]> {
	if (!provider.base_url) throw new Error(`Provider "${provider.name}" is missing a base URL`);
	const headers: Record<string, string> = {};
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

	// OpenRouter's /models only returns text models by default. Ask for the
	// modalities the app actually supports so transcription/speech/etc. show up.
	const isOR = isOpenRouter(provider);
	const url = new URL(`${provider.base_url.replace(/\/$/, '')}/models`);
	if (isOR)
		url.searchParams.set(
			'output_modalities',
			'text,image,video,audio,speech,transcription,decisions'
		);

	const res = await fetch(url.toString(), { headers });
	if (!res.ok) throw new Error(`Provider /models probe failed: ${res.status} ${await res.text()}`);
	const body = (await res.json()) as {
		data?: {
			id: string;
			architecture?: { input_modalities?: unknown; output_modalities?: unknown };
			modalities?: unknown;
			pricing?: {
				prompt?: unknown;
				completion?: unknown;
				input_cache_read?: unknown;
				input_cache_write?: unknown;
			};
			context_length?: unknown;
			top_provider?: { context_length?: unknown };
			/** OpenRouter: the voices a text-to-speech model accepts. */
			supported_voices?: unknown;
			/** Speaches: the model's voices, as `{ id, name, … }` objects. */
			voices?: unknown;
			/** Speaches: what the model does, e.g. `text-to-speech`. */
			task?: unknown;
		}[];
	};
	return (body.data ?? []).map((m) => {
		// OpenRouter returns a flat `modalities` array; other providers use
		// `architecture.input_modalities` / `architecture.output_modalities`. Try both.
		const rawModalities: string[] = Array.isArray(m.modalities)
			? (m.modalities as unknown[]).filter((x): x is string => typeof x === 'string')
			: Array.isArray(m.architecture?.input_modalities)
				? (m.architecture.input_modalities as unknown[]).filter(
						(x): x is string => typeof x === 'string'
					)
				: [];

		const outputs: string[] = Array.isArray(m.architecture?.output_modalities)
			? (m.architecture.output_modalities as unknown[]).filter(
					(x): x is string => typeof x === 'string'
				)
			: [];

		// Map each input modality to a capability tag. Unmapped modalities are kept as-is.
		// An image *input* means the model can see images ('vision'); generating
		// images is an image *output* ('image', what the image role picker filters on).
		const modalityToCapability: Record<string, string | undefined> = {
			audio: 'transcription',
			speech: 'speech',
			text: 'chat',
			image: 'vision',
			video: 'video',
			decisions: 'decisions'
		};

		// 'chat' is always present (default capability)
		const capabilities = new Set<string>(['chat', 'streaming']);
		for (const mod of rawModalities) {
			const cap = modalityToCapability[mod] ?? mod;
			capabilities.add(cap);
		}
		if (outputs.includes('image')) capabilities.add('image');
		// Spoken output means a text-to-speech model.
		if (outputs.includes('speech')) capabilities.add('speech');
		// Speaches names each model's task instead of its modalities.
		if (m.task === 'text-to-speech') capabilities.add('speech');
		if (m.task === 'automatic-speech-recognition') capabilities.add('transcription');

		return {
			id: m.id,
			capabilities: [...capabilities],
			priceInput: pricePerMillion(m.pricing?.prompt),
			priceOutput: pricePerMillion(m.pricing?.completion),
			priceCacheRead: pricePerMillion(m.pricing?.input_cache_read),
			priceCacheWrite: pricePerMillion(m.pricing?.input_cache_write),
			contextLength: contextLength(m),
			voices: voiceNames(m.supported_voices) ?? voiceNames(m.voices)
		};
	});
}

export async function fetchProviderModels(providerId: string): Promise<FetchedModel[]> {
	const provider = getProvider(getDb(), providerId);
	if (!provider) throw new ModelUnavailableError(`Provider ${providerId} not found`);
	return fetchModelsForProvider(provider);
}

/** What listing a provider's models needs: enough to try one before saving it. */
export type ProviderFetchConfig = Pick<ProviderRow, 'name' | 'type' | 'base_url' | 'api_key_enc'>;

/** Lists the models a provider offers, saved or not (onboarding tries one before saving it). */
export async function fetchModelsForProvider(
	provider: ProviderFetchConfig
): Promise<FetchedModel[]> {
	const apiKey = provider.api_key_enc ? decryptSecret(provider.api_key_enc) : undefined;
	if (provider.type === 'anthropic') return fetchAnthropicModels(provider, apiKey);
	const fetched = await fetchOpenAICompatibleModels(provider, apiKey);
	return isLmStudioProvider(provider) ? withLmStudioContext(provider, fetched) : fetched;
}

/**
 * LM Studio's OpenAI /models carries no context sizes. Its native API does: the
 * loaded context is kept; the trained maximum is not, as a model is usually
 * loaded with far less and compacting against the maximum would come too late.
 */
async function withLmStudioContext(
	provider: ProviderFetchConfig,
	fetched: FetchedModel[]
): Promise<FetchedModel[]> {
	const native = await fetchLmStudioModels(provider);
	if (!native) return fetched;
	const loaded = new Map(native.map((m) => [m.id, m.loadedContextLength]));
	return fetched.map((m) => ({ ...m, contextLength: m.contextLength ?? loaded.get(m.id) ?? null }));
}
