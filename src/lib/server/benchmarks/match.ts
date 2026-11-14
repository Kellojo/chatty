import type { AaModel } from '../db/repo/aa-models.js';

export interface ModelScore {
	/** Artificial Analysis Intelligence Index. */
	index: number;
	/** The Artificial Analysis entry it was matched to, e.g. "GLM-5.3 (Max)". */
	aaName: string;
	aaSlug: string;
}

/** Words that never tell two models apart ("gpt-4o-latest" is gpt-4o). */
const NOISE = new Set(['latest', 'free']);

/** Alphanumeric tokens of a model name, without the vendor prefix, ":tag" or date suffixes. */
export function tokens(raw: string): string[] {
	let s = raw.toLowerCase().trim();
	s = s.slice(s.lastIndexOf('/') + 1); // "z-ai/glm-5.3" → "glm-5.3"
	s = s.replace(/:[^:]*$/, ''); // "…:free", "…:beta"
	s = s.replace(/[-_ ]?(\d{4}-\d{2}-\d{2}|\d{8})$/, ''); // "…-20250929", "…-2025-09-29"
	return s.split(/[^a-z0-9]+/).filter((t) => t && !NOISE.has(t));
}

/** Two lookup keys: the joined tokens ("gpt4o"), and the sorted tokens, which ignores word
 *  order ("llama-3.1-8b-instruct" and "Llama 3.1 Instruct 8B" agree). */
export function keys(raw: string): string[] {
	const t = tokens(raw);
	if (t.length === 0) return [];
	return [t.join(''), `~${[...t].sort().join(' ')}`];
}

/** "(Reasoning)", "(Max)", "(Non-reasoning)"… */
const VARIANT = /\s*\([^)]*\)\s*/g;
const isVariant = (m: AaModel) => /\([^)]*\)/.test(m.name);

/** Of several entries sharing a key, the plain one wins over "(Reasoning)"/"(Max)" variants;
 *  among equals, the higher score. */
function better(a: AaModel, b: AaModel): AaModel {
	const av = isVariant(a);
	const bv = isVariant(b);
	if (av !== bv) return av ? b : a;
	return (b.intelligenceIndex ?? -1) > (a.intelligenceIndex ?? -1) ? b : a;
}

/**
 * Matches local models to Artificial Analysis entries by normalised id or name. Unmatched
 * models are left out; nothing is guessed beyond the normalisation rules.
 */
export function matchScores(
	models: { id: string; modelId: string; displayName: string }[],
	aaModels: AaModel[]
): Record<string, ModelScore> {
	const byKey = new Map<string, AaModel>();
	for (const aa of aaModels) {
		if (aa.intelligenceIndex === null) continue;
		const names = [aa.slug, aa.name.replace(VARIANT, ' ')];
		for (const key of new Set(names.flatMap(keys))) {
			const current = byKey.get(key);
			byKey.set(key, current ? better(current, aa) : aa);
		}
	}
	const scores: Record<string, ModelScore> = {};
	for (const model of models) {
		const candidates = [model.modelId, model.displayName].flatMap(keys);
		// Joined-token keys first: they are the stricter match.
		candidates.sort((a, b) => Number(a.startsWith('~')) - Number(b.startsWith('~')));
		const hit = candidates.map((k) => byKey.get(k)).find(Boolean);
		if (hit && hit.intelligenceIndex !== null) {
			scores[model.id] = { index: hit.intelligenceIndex, aaName: hit.name, aaSlug: hit.slug };
		}
	}
	return scores;
}
