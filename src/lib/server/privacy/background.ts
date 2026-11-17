/**
 * Background model calls for a chat (title, compaction, step compaction): which
 * target they use. Normally the role model, else the chat's own. For a private
 * chat (Q4): the role model only if it is trusted, else the chat's own first
 * trusted target, else none (the caller then uses a placeholder or skips).
 */
import type { ModelMappingTarget } from '$lib/types.js';
import type { Db } from '../db/index.js';
import { findRoleModel, type ModelRole } from '../db/repo/models.js';
import { resolveRefTargets } from '../llm/mapped.js';
import { filterTargets, isPrivateContext, type Privacy } from './policy.js';

function roleTargets(db: Db, role: ModelRole): ModelMappingTarget[] {
	const model = findRoleModel(db, role);
	if (!model) return [];
	try {
		return resolveRefTargets({ providerId: model.provider_id, modelId: model.model_id }, db)
			.targets;
	} catch {
		return [];
	}
}

/** The target for a chat's `role` call, or null when a private chat has no trusted one. */
export function backgroundTarget(
	db: Db,
	role: ModelRole,
	chatRef: { providerId: string; modelId: string },
	privacy: Privacy
): ModelMappingTarget | null {
	const fromRole = roleTargets(db, role);
	if (!isPrivateContext(db, privacy)) {
		return fromRole[0] ?? resolveRefTargets(chatRef, db).targets[0] ?? null;
	}
	let fromChat: ModelMappingTarget[] = [];
	try {
		fromChat = resolveRefTargets(chatRef, db).targets;
	} catch {
		// A chat whose model went away just has no target of its own.
	}
	return (
		filterTargets(db, fromRole.slice(0, 1), privacy)[0] ??
		filterTargets(db, fromChat, privacy)[0] ??
		null
	);
}

/** The title a private chat gets when no trusted model can write one, e.g. "Private chat · 14 Nov". */
export function privatePlaceholderTitle(now = new Date()): string {
	return `Private chat · ${now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
}
