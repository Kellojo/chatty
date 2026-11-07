// Pure parsing of a T3 server's `server.getConfig` result into the model
// choices Chatty offers for coding tasks. Everything is untrusted input.

import type { CodingModelOption, CodingModelRef } from '$lib/coding-environments.js';
import { providerLabel } from '$lib/coding-environments.js';

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null =>
	v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null;
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

const sameModel = (a: CodingModelRef, b: CodingModelRef) =>
	a.providerInstanceId === b.providerInstanceId && a.model === b.model;

/** A T3 `ModelSelection` (`{ instanceId, model }`), or null. */
export function parseModelSelection(value: unknown): CodingModelRef | null {
	const selection = rec(value);
	const instanceId = str(selection?.instanceId);
	const model = str(selection?.model);
	return instanceId && model ? { providerInstanceId: instanceId, model } : null;
}

/** T3's favourite models (`settings.favorites`: `{ provider: <instance id>, model }`). */
export function parseFavorites(settings: unknown): CodingModelRef[] {
	const list = rec(settings)?.favorites;
	if (!Array.isArray(list)) return [];
	return list.flatMap((entry) => {
		const f = rec(entry);
		const instanceId = str(f?.provider) ?? str(f?.instanceId);
		const model = str(f?.model);
		return instanceId && model ? [{ providerInstanceId: instanceId, model }] : [];
	});
}

/**
 * Models of the providers that are enabled and ready. Favourites are flagged
 * and listed first within their provider; otherwise T3's order is kept.
 */
export function parseModels(
	config: unknown,
	favorites: CodingModelRef[] = []
): CodingModelOption[] {
	const providers = rec(config)?.providers;
	const options: CodingModelOption[] = [];
	for (const entry of Array.isArray(providers) ? providers : []) {
		const p = rec(entry);
		const instanceId = str(p?.instanceId);
		const driver = str(p?.driver);
		if (!p || !instanceId || !driver) continue;
		if (p.enabled === false || p.installed === false || p.availability === 'unavailable') continue;
		if (p.status === 'error' || p.status === 'disabled') continue;
		const label = str(p.displayName) ?? providerLabel(driver);
		const own: CodingModelOption[] = [];
		for (const m of Array.isArray(p.models) ? p.models : []) {
			const model = rec(m);
			const slug = str(model?.slug);
			if (!model || !slug || model.isLegacy === true) continue;
			const ref = { providerInstanceId: instanceId, model: slug };
			own.push({
				...ref,
				provider: driver,
				providerLabel: label,
				label: str(model.name) ?? slug,
				favorite: favorites.some((f) => sameModel(f, ref))
			});
		}
		// Stable: favourites first, then the rest in T3's order.
		options.push(...own.filter((m) => m.favorite), ...own.filter((m) => !m.favorite));
	}
	return options;
}

/**
 * The model to preselect: the first candidate that is available (candidates
 * in T3's precedence order), else the first available favourite, else the
 * first model at all.
 */
export function resolveDefaultModel(
	candidates: (CodingModelRef | null)[],
	models: CodingModelOption[]
): CodingModelRef | null {
	const pick =
		candidates.find((c) => c && models.some((m) => sameModel(m, c))) ??
		models.find((m) => m.favorite) ??
		models[0];
	return pick ? { providerInstanceId: pick.providerInstanceId, model: pick.model } : null;
}
