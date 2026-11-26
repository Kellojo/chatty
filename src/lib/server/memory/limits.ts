/**
 * Shape limits for notes the built-in memory agents write. Small local models
 * follow "keep it short" poorly, so the memory tools enforce it: a write that
 * breaks a limit is refused with a message saying how to fix it. Notes people
 * (or their chat models) write are left alone.
 */

export const MAX_DESCRIPTION_CHARS = 200;
export const MAX_TAGS = 6;
export const MAX_BODY_CHARS = 2500;
export const MAX_BODY_HASHES = 2;

/**
 * A commit hash: a short (7–12) or full (40) run of hex digits with at least
 * three digits and one letter, so hex-looking words ("deadbeef", "facade12")
 * pass. Can still misfire on rare names like "a1b2c3d4"; the refusal says why,
 * so the writer can rephrase.
 */
const HASH_LIKE = /\b(?=(?:[a-f]*\d){3})(?=[0-9a-f]*[a-f])([0-9a-f]{7,12}|[0-9a-f]{40})\b/i;
const HASHES = new RegExp(HASH_LIKE.source, 'gi');
/**
 * Tags that only date a note or tie it to one piece of work: release versions
 * (v1.2, not v8), PR and migration numbers, recent years and dates (2026,
 * 2026-11, q4-2026, not a number like 4090), and numbered or dated work
 * sessions (wave-2026-11-25, phase-2, not session-cookies).
 */
const DATING_TAG =
	/^(v\d+(\.\d+)+|(migration|pr)-?\d+|20[23]\d|\d{4}-\d{2}(-\d{2})?|q[1-4]-?\d{4}|(wave|session|sprint|phase|milestone)-?\d[\w-]*|wip|uncommitted)$/i;

/** A note named after a work session or a date ("wave-2026-11-25", "Sprint 3"), not a subject. */
const SESSION_NAME = /\b(wave|session|sprint|phase|milestone)[-_\s]?\d|\b\d{4}-\d{2}(-\d{2})?\b/i;
const DATE_IN_NAME = /\b\d{4}-\d{2}(-\d{2})?\b/;
/** A dated update or history heading ("## Update (2026-11-12)"): history appended, not rewritten. */
const DATED_HISTORY =
	/^#{1,6}[^\n]*\b(updated?|updates|changelog|history)\b[^\n]*(\d{4}|\bas of\b)/gim;
/** Frontmatter pasted into the body, which the tools write from their arguments. */
const BODY_FRONTMATTER = /^\s*---\s*\n[\s\S]*?\n---\s*(\n|$)/;

export interface ConceptShape {
	/** Path and title, checked on notes being created or renamed. */
	path?: string;
	title?: string;
	description?: string;
	tags?: string[];
	body: string;
}

type ProblemKind =
	| 'session-name'
	| 'description-length'
	| 'description-hash'
	| 'tag-count'
	| 'dating-tags'
	| 'tag-format'
	| 'body-frontmatter'
	| 'dated-history'
	| 'body-hashes'
	| 'body-length';

export interface ShapeProblem {
	field: 'path' | 'title' | 'description' | 'tags' | 'body';
	kind: ProblemKind;
	message: string;
	/** How bad it is: a length or count, or the offending tags. */
	measure: number | string[];
}

/** Every way the note breaks the limits (empty when it fits). */
export function conceptShapeProblems({
	path,
	title,
	description,
	tags,
	body
}: ConceptShape): ShapeProblem[] {
	const problems: ShapeProblem[] = [];
	// Titles are prose ("Phase 2 rollout" can be a subject): only a date counts there.
	for (const [field, value, pattern] of [
		['path', path, SESSION_NAME],
		['title', title, DATE_IN_NAME]
	] as const) {
		if (value && pattern.test(value)) {
			problems.push({
				field,
				kind: 'session-name',
				measure: 1,
				message: `${field} "${value}" names a work session or date: name the note after its subject and put each fact in the note of its subject`
			});
			break;
		}
	}
	const desc = description?.trim() ?? '';
	if (desc.length > MAX_DESCRIPTION_CHARS) {
		problems.push({
			field: 'description',
			kind: 'description-length',
			measure: desc.length,
			message: `description is ${desc.length} characters (max ${MAX_DESCRIPTION_CHARS}): write one plain sentence saying what the note is about, and leave dates, versions and status to the body`
		});
	}
	if (HASH_LIKE.test(desc)) {
		problems.push({
			field: 'description',
			kind: 'description-hash',
			measure: 1,
			message: 'description contains a commit hash: leave it out'
		});
	}
	const tagList = tags ?? [];
	if (tagList.length > MAX_TAGS) {
		problems.push({
			field: 'tags',
			kind: 'tag-count',
			measure: tagList.length,
			message: `${tagList.length} tags (max ${MAX_TAGS}): keep the few words someone would search for`
		});
	}
	const badFormat = tagList.filter((t) => /[A-Z\s]/.test(t.trim()));
	if (badFormat.length > 0) {
		problems.push({
			field: 'tags',
			kind: 'tag-format',
			measure: badFormat,
			message: `tags are single lowercase words or hyphenated-words (${badFormat.join(', ')})`
		});
	}
	const dating = tagList.filter((t) => DATING_TAG.test(t.trim()));
	if (dating.length > 0) {
		problems.push({
			field: 'tags',
			kind: 'dating-tags',
			measure: dating,
			message: `drop tags that only date the note or name a work session (${dating.join(', ')})`
		});
	}
	if (BODY_FRONTMATTER.test(body)) {
		problems.push({
			field: 'body',
			kind: 'body-frontmatter',
			measure: 1,
			message:
				'body starts with frontmatter: pass title, type, description and tags as arguments and keep the body to markdown'
		});
	}
	const history = body.match(DATED_HISTORY)?.length ?? 0;
	if (history > 0) {
		problems.push({
			field: 'body',
			kind: 'dated-history',
			measure: history,
			message: `body has ${history} dated update or history section(s): fold their facts into the text they change and delete the sections`
		});
	}
	// A hash or two in a body can be a fact worth keeping (a pinned version, an
	// ID the user refers to); a list of them is a changelog.
	const hashes = body.match(HASHES)?.length ?? 0;
	if (hashes > MAX_BODY_HASHES) {
		problems.push({
			field: 'body',
			kind: 'body-hashes',
			measure: hashes,
			message: `body has ${hashes} commit hashes (max ${MAX_BODY_HASHES}): say what was done, not which commits did it`
		});
	}
	const length = body.trim().length;
	if (length > MAX_BODY_CHARS) {
		problems.push({
			field: 'body',
			kind: 'body-length',
			measure: length,
			message: `body is ${length} characters (max ${MAX_BODY_CHARS}): cut logs, hashes, test counts, history and text that newer facts replaced; if durable facts remain over the limit, split them into one note per subject`
		});
	}
	return problems;
}

/** Whether `after` is no worse than `before`, a problem of the same kind. */
function noWorse(after: ShapeProblem, before: ShapeProblem | undefined): boolean {
	if (!before) return false;
	if (Array.isArray(after.measure)) {
		const old = new Set(before.measure as string[]);
		return after.measure.every((t) => old.has(t));
	}
	return after.measure <= (before.measure as number);
}

/**
 * The problems an update brings: those `after` has that `before` didn't, or
 * has worse. An update that leaves an over-long legacy note no longer than it
 * was (a link repair, a reworded sentence) isn't refused for it.
 */
export function conceptShapeRegressions(before: ConceptShape, after: ConceptShape): ShapeProblem[] {
	const old = conceptShapeProblems(before);
	return conceptShapeProblems(after).filter(
		(p) =>
			!noWorse(
				p,
				old.find((o) => o.kind === p.kind)
			)
	);
}

/** The refusal for `problems`, or null when there are none. */
export function shapeRefusal(problems: ShapeProblem[]): string | null {
	return problems.length > 0
		? `note not saved: ${problems.map((p) => p.message).join('; ')}`
		: null;
}

/** Why the note may not be written as is, or null when it fits. */
export function conceptShapeProblem(shape: ConceptShape): string | null {
	return shapeRefusal(conceptShapeProblems(shape));
}
