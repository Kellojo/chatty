import { requireAdmin } from '$lib/server/auth/guards.js';
import { getDb } from '$lib/server/db/index.js';
import {
	listModels,
	listRoleDefaults,
	toPublic as modelToPublic
} from '$lib/server/db/repo/models.js';
import {
	listEnabledModelMappings,
	toPublic as mappingToPublic
} from '$lib/server/db/repo/model-mappings.js';
import { listProviders, toPublic as providerToPublic } from '$lib/server/db/repo/providers.js';
import { FALLBACK_VOICE, getDefaultVoice } from '$lib/server/speech/synthesizer.js';
import { roleVoices } from '$lib/server/speech/voices.js';
import { isPrivateDataEnabled } from '$lib/server/privacy/feature.js';
import { findRoleModel, type ModelRole } from '$lib/server/db/repo/models.js';
import { roleTrusted } from '$lib/server/privacy/models.js';
import type { PageServerLoad } from './$types';

/** Roles that can see a private chat's data; the chat role only picks new chats' model. */
const PRIVATE_ROLES: ModelRole[] = [
	'title',
	'compaction',
	'memory',
	'image',
	'speech-to-text',
	'text-to-speech'
];

export const load: PageServerLoad = async ({ locals }) => {
	requireAdmin(locals);
	const db = getDb();
	const models = listModels(db).map(modelToPublic);
	const capsByRef = new Map(models.map((m) => [`${m.providerId}/${m.modelId}`, m.capabilities]));
	const mappings = listEnabledModelMappings(db).map((row) => {
		const mapping = mappingToPublic(row);
		const capabilities = [
			...new Set(
				mapping.targets.flatMap((t) => capsByRef.get(`${t.providerId}/${t.modelId}`) ?? [])
			)
		];
		return { ...mapping, capabilities };
	});
	return {
		providers: listProviders(db).map(providerToPublic),
		models,
		mappings,
		roles: listRoleDefaults(db),
		ttsVoice: getDefaultVoice(db),
		/** The Text to speech model's voices; null shows a free-text field instead. */
		ttsVoices: await roleVoices(db),
		fallbackVoice: FALLBACK_VOICE,
		/** Roles set to a model that may not process private data (warned about when private data is on). */
		untrustedRoles: isPrivateDataEnabled(db)
			? PRIVATE_ROLES.filter((role) => findRoleModel(db, role) && !roleTrusted(db, role))
			: []
	};
};
