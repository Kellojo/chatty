import type { MemoryViewTotals } from '$lib/memory-types.js';
import type { MemoryScope } from '../../memory/paths.js';
import type { Db } from '../index.js';
import { usageDay } from './mcp-tool-usage.js';

export type MemoryViewKind = 'search' | 'read';

export interface MemoryViewInput {
	kind: MemoryViewKind;
	/** Concepts viewed at once, e.g. every hit of one search. */
	concepts: { scope: MemoryScope; path: string }[];
	userId: string;
	/** True when an agent run made the call, not a chat. */
	agent: boolean;
	at?: number;
}

/** Counts concepts towards their views: search hits or reads, per user, day and caller. */
export function recordMemoryViews(db: Db, input: MemoryViewInput): void {
	if (input.concepts.length === 0) return;
	const at = input.at ?? Date.now();
	const hit = input.kind === 'search' ? 1 : 0;
	const read = input.kind === 'read' ? 1 : 0;
	const upsert = db.prepare(
		`INSERT INTO memory_views (scope, concept_path, user_id, day, via, search_hits, reads, last_viewed_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT (scope, concept_path, user_id, day, via) DO UPDATE SET
		   search_hits = search_hits + excluded.search_hits,
		   reads = reads + excluded.reads,
		   last_viewed_at = MAX(last_viewed_at, excluded.last_viewed_at)`
	);
	const day = usageDay(at);
	const via = input.agent ? 'agent' : 'chat';
	db.transaction(() => {
		// A search can list the same concept once only, but dedupe so a caller's slip can't double count.
		const seen = new Set<string>();
		for (const c of input.concepts) {
			const key = `${c.scope}:${c.path}`;
			if (seen.has(key)) continue;
			seen.add(key);
			upsert.run(c.scope, c.path, input.userId, day, via, hit, read, at);
		}
	})();
}

/** A concept's views since tracking began; `user` scope counts only its owner's. */
export function getMemoryViewTotals(
	db: Db,
	scope: MemoryScope,
	path: string,
	userId: string
): MemoryViewTotals {
	const row = db
		.prepare(
			`SELECT COALESCE(SUM(search_hits), 0) AS searchHits,
			        COALESCE(SUM(reads), 0) AS reads,
			        COALESCE(SUM(CASE WHEN via = 'agent' THEN search_hits ELSE 0 END), 0) AS agentSearchHits,
			        COALESCE(SUM(CASE WHEN via = 'agent' THEN reads ELSE 0 END), 0) AS agentReads,
			        MAX(last_viewed_at) AS lastViewedAt
			 FROM memory_views
			 WHERE scope = @scope AND concept_path = @path AND (@scope = 'shared' OR user_id = @userId)`
		)
		.get({ scope, path, userId }) as MemoryViewTotals;
	return row;
}

/** Carries a concept's views over to its new path, so renaming it doesn't reset them. */
export function moveMemoryViews(
	db: Db,
	scope: MemoryScope,
	userId: string,
	from: string,
	to: string
): void {
	const owner = scope === 'shared' ? '' : 'AND user_id = @userId';
	db.transaction(() => {
		// Fold the old rows into any already at the new path (a concept that once lived there).
		db.prepare(
			`INSERT INTO memory_views (scope, concept_path, user_id, day, via, search_hits, reads, last_viewed_at)
			 SELECT scope, @to, user_id, day, via, search_hits, reads, last_viewed_at
			 FROM memory_views WHERE scope = @scope AND concept_path = @from ${owner}
			 ON CONFLICT (scope, concept_path, user_id, day, via) DO UPDATE SET
			   search_hits = search_hits + excluded.search_hits,
			   reads = reads + excluded.reads,
			   last_viewed_at = MAX(last_viewed_at, excluded.last_viewed_at)`
		).run({ scope, from, to, userId });
		db.prepare(
			`DELETE FROM memory_views WHERE scope = @scope AND concept_path = @from ${owner}`
		).run({ scope, from, userId });
	})();
}
