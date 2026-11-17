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
import {
	ConceptWriteRefused,
	listConceptPaths,
	readConcept,
	writeConcept,
	type Concept,
	type ConceptWriteGuard
} from '../memory/bundle.js';
import { ftsScope, type MemoryScope } from '../memory/paths.js';
import { canClassify, classifySensitive, reviewUpdate } from './classify.js';

const log = createLogger('privacy');

/** Notes checked per run at most; the rest wait for the next run. */
export const SWEEP_LIMIT = 50;

/** Failed checks in a row after which a run gives up (the model is likely down). */
const MAX_CONSECUTIVE_FAILURES = 3;

/** What the check reads: the note's text, not its flags, so unmarking doesn't count as a change. */
function checkedText(concept: Concept): string {
	const fm = concept.frontmatter;
	return [fm.title, fm.description, fm.tags.join(', '), concept.body].join('\n');
}

const hashOf = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * Refuses the sweep's write when the note changed while it was classified:
 * it was deleted, its text was edited, or its privacy was set meanwhile. The
 * write would otherwise put back the old text or override that decision.
 */
function unchangedSince(read: Concept, hash: string): ConceptWriteGuard {
	return (current) => {
		if (!current) return 'The note was deleted';
		if (hashOf(checkedText(current)) !== hash) return 'The note was edited';
		const a = read.frontmatter;
		const b = current.frontmatter;
		if (Boolean(a.private) !== Boolean(b.private) || a.privateReason !== b.privateReason) {
			return "The note's privacy changed";
		}
		return null;
	};
}

export interface SweepResult {
	checked: number;
	/** Paths marked private by this sweep. */
	marked: string[];
	/** Automatically marked notes that no longer look personal, flagged for a person to review. */
	flagged: string[];
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
	const result: SweepResult = { checked: 0, marked: [], flagged: [] };
	let failures = 0;
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
		// Public notes, and notes marked private automatically (which may no longer
		// need to be). Notes a person or a private chat made private are theirs.
		if (!concept) continue;
		const fm = concept.frontmatter;
		if (fm.private && !fm.privateReason) continue;
		const text = checkedText(concept);
		const hash = hashOf(text);
		const last = lastHash.get(key, concept.path) as { content_hash: string } | undefined;
		if (last?.content_hash === hash) continue;
		result.checked++;
		const labels = await classifySensitive(db, text);
		if (labels === null) {
			// One note the model can't answer for mustn't hold up the rest; a model
			// that is down or no longer trusted stops the run (the rest waits).
			failures++;
			if (!canClassify(db) || failures >= MAX_CONSECUTIVE_FAILURES) {
				log.warn('Memory privacy sweep stopped: checks failed', {
					scope: key,
					checked: result.checked
				});
				break;
			}
			continue;
		}
		failures = 0;
		const update = reviewUpdate(fm, labels);
		if (update) {
			const written = await writeConcept(
				db,
				scope,
				userId,
				concept.path,
				{
					frontmatter: {
						...fm,
						timestamp: fm.timestamp || undefined,
						private: true,
						...update
					},
					body: concept.body
				},
				{ author: 'memory-cleanup', userId },
				unchangedSince(concept, hash)
			).catch((e: unknown) => {
				if (e instanceof ConceptWriteRefused) return null;
				throw e;
			});
			// Deleted or edited while it was classified: the next run checks it as it is now.
			if (!written) continue;
			if (!fm.private) result.marked.push(concept.path);
			else if (update.privateReview) result.flagged.push(concept.path);
		}
		record.run(key, concept.path, hash, Date.now());
	}
	if (result.checked > 0) {
		log.info('Memory privacy sweep', {
			scope: key,
			checked: result.checked,
			marked: result.marked.length,
			flagged: result.flagged.length
		});
	}
	return result;
}

/**
 * Records that `concept`, as it is now, needs no sweep: it was just checked
 * (a tool save) or a person just decided its privacy (the memory editor). The
 * sweep then leaves it until its text changes.
 */
export function recordPrivacyCheck(db: Db, concept: Concept, userId: string): void {
	db.prepare(
		`INSERT INTO memory_privacy_checks (scope, path, content_hash, checked_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT (scope, path) DO UPDATE SET content_hash = excluded.content_hash, checked_at = excluded.checked_at`
	).run(ftsScope(concept.scope, userId), concept.path, hashOf(checkedText(concept)), Date.now());
}
