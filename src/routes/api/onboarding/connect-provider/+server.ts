import { json, error } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/auth/guards.js';
import { encryptSecret } from '$lib/server/crypto.js';
import { getDb } from '$lib/server/db/index.js';
import {
	findRoleModel,
	listModels,
	setRoleDefault,
	toPublic as modelToPublic,
	upsertFetchedModels
} from '$lib/server/db/repo/models.js';
import { createProvider, toPublic as providerToPublic } from '$lib/server/db/repo/providers.js';
import { fetchModelsForProvider } from '$lib/server/llm/registry.js';
import { providerCreateSchema } from '$lib/server/llm/provider-input.js';
import { refreshScores } from '$lib/server/benchmarks/artificial-analysis.js';
import { pickDefaultChatModel } from '$lib/onboarding.js';
import type { RequestHandler } from './$types';

/**
 * Onboarding's "Connect": lists the provider's models *before* saving anything,
 * then saves the provider, its models and (when none is set) the Default chat
 * model in one transaction. A bad key or URL leaves no trace.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	requireAdmin(locals);
	const parsed = providerCreateSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, { message: parsed.error.issues[0]?.message ?? 'Invalid body' });
	const input = parsed.data;

	let fetched;
	try {
		fetched = await fetchModelsForProvider({
			name: input.name,
			type: input.type,
			base_url: input.baseUrl ?? null,
			api_key_enc: input.apiKey ? encryptSecret(input.apiKey) : null
		});
	} catch (e) {
		error(502, { message: connectErrorMessage(e) });
	}
	// Picked in the provider's own order, which tends to list its newest models first.
	const pick = pickDefaultChatModel(fetched.map(toCandidate));
	if (!pick) {
		error(422, {
			message: 'Connected, but no chat models were found. Check the URL points at the API.'
		});
	}

	const db = getDb();
	const result = db.transaction(() => {
		const provider = createProvider(db, input);
		upsertFetchedModels(db, provider.id, fetched);
		const models = listModels(db, provider.id).map(modelToPublic);
		const picked = models.find((m) => m.modelId === pick.modelId);
		let chatModelId: string | null = null;
		if (picked && !findRoleModel(db, 'chat')) {
			setRoleDefault(db, 'chat', picked.id);
			chatModelId = picked.id;
		}
		return { provider: providerToPublic(provider), models, chatModelId };
	})();
	// Same as a manual sync: scores for the new models (at most hourly; never fails this).
	await refreshScores(db, 'sync');
	return json(result, { status: 201 });
};

function toCandidate(model: { id: string; capabilities?: string[] }) {
	return { modelId: model.id, capabilities: model.capabilities ?? ['chat', 'streaming'] };
}

/** The provider's own error, minus noise, so the user sees what to fix. */
function connectErrorMessage(e: unknown): string {
	const raw = e instanceof Error ? e.message : String(e);
	if (/\b(401|403)\b/.test(raw)) return 'The provider rejected that API key.';
	if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|timed? ?out/i.test(raw)) {
		return 'Couldn’t reach that URL. Check it’s right and the server is running.';
	}
	if (/requires an API key/.test(raw)) return 'This provider needs an API key.';
	return raw.length > 300 ? `${raw.slice(0, 300)}…` : raw;
}
