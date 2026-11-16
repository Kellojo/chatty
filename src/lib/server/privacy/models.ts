/**
 * Whether a model setting only reaches providers trusted with private data:
 * a role default (title, speech…) or a model ref (a mapping counts only when
 * every target is trusted).
 */
import type { Db } from '../db/index.js';
import { findRoleModel, type ModelRole } from '../db/repo/models.js';
import { resolveRefTargets } from '../llm/mapped.js';
import { turnTrust } from './policy.js';

/** Whether every target of the role's model is on a trusted provider (false when unset). */
export function roleTrusted(db: Db, role: ModelRole): boolean {
	const model = findRoleModel(db, role);
	if (!model) return false;
	return modelRefTrusted(db, model.provider_id, model.model_id);
}

/** Whether a model ref only reaches trusted providers; null means the default chat model. */
export function modelRefTrusted(
	db: Db,
	providerId: string | null | undefined,
	modelId: string | null | undefined
): boolean {
	if (!providerId || !modelId) {
		const chat = findRoleModel(db, 'chat');
		if (!chat) return false;
		providerId = chat.provider_id;
		modelId = chat.model_id;
	}
	try {
		return turnTrust(db, resolveRefTargets({ providerId, modelId }, db).targets) === 'trusted';
	} catch {
		return false;
	}
}
