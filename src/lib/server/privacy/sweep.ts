/**
 * The privacy sweep the memory cleanup run does: checks public memory notes
 * that are new or changed since their last check with the Decisions model
 * (see classify.ts) and marks the ones with personal information private.
 * Catches notes saved before automatic marking existed, or written in the
 * memory editor, which saves exactly what a person chose.
 */
import { createHash } from 'node:crypto';
import type { Db } from '../db/index.js';
import { createLogger } from '../logger.js';
import { listConceptPaths, readConcept, writeConcept, type Concept } from '../memory/bundle.js';
import { ftsScope, type MemoryScope } from '../memory/paths.js';
import { canClassify, classifySensitive, privateReasonFor } from './classify.js';

const log = createLogger('privacy');

/** Notes checked per run at most; the rest wait for the next run. */
export const SWEEP_LIMIT = 50;

/** What the check reads: the note's text, not its flags, so unmarking doesn't count as a change. */
function checkedText(concept: Concept): string {
	const fm = concept.frontmatter;
	return [fm.title, fm.description, fm.tags.join(', '), concept.body].join('\n');
}

const hashOf = (text: string) => createHash('sha256').update(text).digest('hex');

export interface SweepResult {
	checked: number;
	/** Paths marked private by this sweep. */
	marked: string[];
}

/**
 * Checks up to `limit` public notes in one bundle that weren't checked in
 * their current form, and marks private the ones the classifier flags. Does
 * nothing without a trusted Decisions model. A failed check leaves the note
 * unrecorded, so the next run tries it again.
 */
export async function sweepMemoryPrivacy(
	db: Db,
	scope: MemoryScope,
	userId: string,
	limit = SWEEP_LIMIT
): Promise<SweepResult> {
	const result: SweepResult = { checked: 0, marked: [] };
	if (!canClassify(db)) return result;
	const key = ftsScope(scope, userId);
	const lastHash = db.prepare(
		'SELECT content_hash FROM memory_privacy_checks WHERE scope = ? AND path = ?'
	);
	const record = db.prepare(
		`INSERT INTO memory_privacy_checks (scope, path, content_hash, checked_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT (scope, path) DO UPDATE SET content_hash = excluded.content_hash, checked_at = excluded.checked_at`
	);
	for (const relPath of await listConceptPaths(scope, userId)) {
		if (result.checked >= limit) break;
		const concept = await readConcept(scope, userId, relPath);
		if (!concept || concept.frontmatter.private) continue;
		const text = checkedText(concept);
		const hash = hashOf(text);
		const last = lastHash.get(key, concept.path) as { content_hash: string } | undefined;
		if (last?.content_hash === hash) continue;
		result.checked++;
		const labels = await classifySensitive(db, text);
		if (labels === null) continue;
		if (labels.length > 0) {
			await writeConcept(
				db,
				scope,
				userId,
				concept.path,
				{
					frontmatter: {
						...concept.frontmatter,
						timestamp: concept.frontmatter.timestamp || undefined,
						private: true,
						privateReason: privateReasonFor(labels)
					},
					body: concept.body
				},
				{ author: 'memory-cleanup', userId }
			);
			result.marked.push(concept.path);
		}
		record.run(key, concept.path, hash, Date.now());
	}
	if (result.checked > 0) {
		log.info('Memory privacy sweep', {
			scope: key,
			checked: result.checked,
			marked: result.marked.length
		});
	}
	return result;
}
