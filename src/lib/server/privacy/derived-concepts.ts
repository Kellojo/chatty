import type { Db } from '../db/index.js';
import { readConcept } from '../memory/bundle.js';
import type { MemoryScope } from '../memory/paths.js';

/** A memory concept that may hold what a chat said (see derivedConcepts). */
export interface DerivedConcept {
	scope: MemoryScope;
	/** Path in its bundle. */
	path: string;
	title: string;
	private: boolean;
}

/** The most concepts listed for one chat. */
const MAX_DERIVED = 200;

type ToolPart = { type?: unknown; toolName?: unknown; input?: unknown };

/** Whether a stored message's parts hold a `read_chat` call for `conversationId`. */
function readsChat(partsJson: string, conversationId: string): boolean {
	let parts: unknown;
	try {
		parts = JSON.parse(partsJson);
	} catch {
		return false;
	}
	if (!Array.isArray(parts)) return false;
	return parts.some((p: ToolPart) => {
		if (typeof p?.type !== 'string') return false;
		const name = p.type === 'dynamic-tool' ? p.toolName : p.type.slice('tool-'.length);
		if (name !== 'read_chat') return false;
		const input = p.input as { conversationId?: unknown } | undefined;
		return input?.conversationId === conversationId;
	});
}

/**
 * The conversations that read `conversationId` with `read_chat`, and when they
 * first did. A subagent's read counts for the conversation that started it,
 * since that one writes the memory. The chat itself counts from its start (its
 * own memory tool calls wrote from it).
 */
function readers(db: Db, userId: string, conversationId: string): Map<string, number> {
	const found = new Map<string, number>([[conversationId, 0]]);
	// A cheap text match first; the parts are then checked properly.
	const rows = db
		.prepare(
			`SELECT COALESCE(c.subagent_of, c.id) AS reader, m.parts, m.created_at
			 FROM messages m JOIN conversations c ON c.id = m.conversation_id
			 WHERE c.user_id = ? AND c.id != ? AND m.role = 'assistant'
			   AND instr(m.parts, 'read_chat') > 0 AND instr(m.parts, ?) > 0
			 ORDER BY m.created_at`
		)
		.all(userId, conversationId, conversationId) as {
		reader: string;
		parts: string;
		created_at: number;
	}[];
	for (const row of rows) {
		if (found.has(row.reader) || !readsChat(row.parts, conversationId)) continue;
		found.set(row.reader, row.created_at);
	}
	return found;
}

/**
 * Concepts that memory runs (or other chats) wrote after reading this chat,
 * as `memory_writes` records them: best effort, since a model may also have
 * learnt the same thing elsewhere, or carried it through a concept it only
 * read. Concepts deleted since are left out; already-private ones are listed
 * with `private: true`.
 */
export async function derivedConcepts(
	db: Db,
	userId: string,
	conversationId: string
): Promise<DerivedConcept[]> {
	const paths = new Set<string>();
	for (const [reader, since] of readers(db, userId, conversationId)) {
		const writes = db
			.prepare(
				`SELECT DISTINCT concept_path FROM memory_writes
				 WHERE conversation_id = ? AND created_at >= ? AND action != 'delete'`
			)
			.all(reader, since) as { concept_path: string }[];
		for (const w of writes) paths.add(w.concept_path);
		if (paths.size >= MAX_DERIVED) break;
	}
	const out: DerivedConcept[] = [];
	for (const stored of [...paths].slice(0, MAX_DERIVED)) {
		// Shared concepts are audited as `shared/<path>` (memory/bundle.ts).
		const scope: MemoryScope = stored.startsWith('shared/') ? 'shared' : 'user';
		const relPath = scope === 'shared' ? stored.slice('shared/'.length) : stored;
		const concept = await readConcept(scope, userId, relPath);
		if (!concept) continue;
		out.push({
			scope,
			path: concept.path,
			title: concept.frontmatter.title,
			private: concept.frontmatter.private === true
		});
	}
	// The user's own notes first, then shared ones; by path within each.
	return out.sort((a, b) =>
		a.scope === b.scope ? a.path.localeCompare(b.path) : a.scope === 'user' ? -1 : 1
	);
}
