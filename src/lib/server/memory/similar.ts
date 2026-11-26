/**
 * Telling whether an existing note is probably about the same subject as a new
 * one, from the words of their titles and tags. Used for the "possibly
 * related" hint of create_concept: a full-text search ORs every word, so its
 * hits alone would name unrelated notes that share a common word.
 */

/** Words that say nothing about a note's subject. */
const STOPWORDS = new Set([
	'about',
	'and',
	'chat',
	'feature',
	'features',
	'for',
	'from',
	'idea',
	'ideas',
	'into',
	'note',
	'notes',
	'plan',
	'plans',
	'project',
	'projects',
	'settings',
	'that',
	'the',
	'their',
	'this',
	'user',
	'users',
	'with'
]);

/**
 * Words are compared by this many leading letters, so "tracker" matches
 * "tracking". Unrelated words with the same start ("carpet", "carpenter")
 * match too; with two shared words needed that rarely names a
 * wrong note, and the hint is advice the writer checks by reading.
 */
const STEM = 5;

/**
 * The distinctive words (as stems) of `text`: 4+ letters, no stopwords, and
 * none of the `common` stems (see commonWords).
 */
export function subjectWords(text: string, common: Set<string> = new Set()): Set<string> {
	const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
	return new Set(
		words
			.filter((w) => w.length >= 4 && !STOPWORDS.has(w))
			.map((w) => w.slice(0, STEM))
			.filter((w) => !common.has(w))
	);
}

/**
 * Stems that appear in so many of a bundle's titles (at least 3, and at least
 * a tenth of them) that sharing them says little, like the name of the app
 * most notes are about.
 */
export function commonWords(titles: string[]): Set<string> {
	const counts = new Map<string, number>();
	for (const title of titles) {
		for (const w of subjectWords(title)) counts.set(w, (counts.get(w) ?? 0) + 1);
	}
	const threshold = Math.max(3, Math.ceil(titles.length / 10));
	return new Set([...counts].filter(([, n]) => n >= threshold).map(([w]) => w));
}

/**
 * Whether a note with `candidate` words shares the subject of one with `words`:
 * two shared words, or the only one when the new note has a single word.
 */
export function sharesSubject(words: Set<string>, candidate: Set<string>): boolean {
	let shared = 0;
	for (const w of words) if (candidate.has(w)) shared++;
	return shared >= Math.min(2, words.size) && shared > 0;
}
