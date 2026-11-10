import type { Db } from '../db/index.js';
import { createAgent, updateAgent } from '../db/repo/agents.js';

export const MEMORY_EXTRACTION_AGENT = 'memory-extraction';

const EXTRACTION_TRIGGER_CONFIG = {
	event: 'chat.created',
	every: 5,
	instructions:
		'New chats have been created since the last extraction. Use search_chats with the "since" parameter to list recent conversations, read_chat to review their contents, then distill durable long-term memory from them.'
} as const;

/**
 * Tells an extraction run exactly which window to cover: everything updated
 * since the previous successful run started (`null` = never ran successfully).
 */
export function extractionWindowNote(lastSuccessAt: number | null): string {
	if (lastSuccessAt === null) {
		return 'There is no previous successful extraction for this user: review all of their conversations (use search_chats with since = 0).';
	}
	const iso = new Date(lastSuccessAt).toISOString();
	return `The last successful extraction for this user started at ${iso}. Pass exactly since = "${iso}" to search_chats, and only extract from conversations updated at or after that time — not from memory timestamps.`;
}

export function seedBuiltinAgent(db: Db): void {
	const existing = db
		.prepare(
			"SELECT id, trigger_type, trigger_config FROM agents WHERE name = 'memory-extraction' AND user_id IS NULL"
		)
		.get() as { id: string; trigger_type: string; trigger_config: string } | undefined;
	if (existing) {
		let cfg: { event?: string; every?: number; instructions?: string } = {};
		try {
			cfg = JSON.parse(existing.trigger_config) as typeof cfg;
		} catch {
			cfg = {};
		}
		if (
			existing.trigger_type !== 'event' ||
			cfg.event !== EXTRACTION_TRIGGER_CONFIG.event ||
			cfg.every !== EXTRACTION_TRIGGER_CONFIG.every ||
			cfg.instructions !== EXTRACTION_TRIGGER_CONFIG.instructions
		) {
			updateAgent(db, existing.id, {
				triggerType: 'event',
				triggerConfig: EXTRACTION_TRIGGER_CONFIG,
				nextRunAt: null
			});
		}
		return;
	}
	createAgent(db, null, {
		name: 'memory-extraction',
		description: 'Extracts long-term memory from recent conversations (built-in).',
		systemPrompt: `You are the memory extraction agent. Each run processes one user's recent conversations and distills them into long-term memory.

Workflow:
1. Use search_chats to find recent conversations, then read_chat to read their contents.
2. Check existing memory first with list_concepts and search_memory; prefer update_concept over create_concept when a concept already exists.
3. Persist only durable facts, preferences, decisions and ongoing projects — never transient chatter, one-off questions or secrets.

Write each memory as an OKF concept via create_concept / update_concept with YAML frontmatter:
- type: concept | person | project | preference | decision
- title: short human-readable name
- description: one-sentence summary
- tags: list of lowercase keywords
- timestamp: ISO 8601 time of extraction

The body is structured markdown. Cross-link related concepts with [[path/to/concept.md]] wiki-links so the memory graph stays connected.`,
		triggerType: 'event',
		triggerConfig: EXTRACTION_TRIGGER_CONFIG,
		enabled: true,
		toolAllowlist: [
			'search_chats',
			'read_chat',
			'search_memory',
			'read_concept',
			'list_concepts',
			'create_concept',
			'update_concept',
			'delete_concept'
		]
	});
}

export function seedMemoryCleanupAgent(db: Db): void {
	const existing = db
		.prepare("SELECT id FROM agents WHERE name = 'memory-cleanup' AND user_id IS NULL")
		.get();
	if (existing) return;
	createAgent(db, null, {
		name: 'memory-cleanup',
		description:
			'Keeps long-term memory tidy on every 5th memory change: merges duplicates, resolves contradictions, prunes noise (built-in).',
		systemPrompt: `You are the memory cleanup agent. Each run processes one user's long-term memory bundle and keeps it accurate and tidy. You are triggered after memories change; the triggering event details are in your instructions.

Workflow:
1. Survey the bundle with list_concepts, then read_concept the recently changed concepts and their neighbors.
2. Merge duplicates: if two concepts cover the same entity, fold them together (update_concept on the keeper, delete_concept on the other) and keep wiki-links pointing at the keeper.
3. Resolve contradictions: when concepts disagree, keep the newest durable fact and update the stale concept.
4. Prune noise: delete_concept on memories that are transient, trivial or clearly outdated. Never delete unique durable facts — prefer update_concept when information is merely stale.
5. Tidy metadata: fix missing or messy frontmatter (type, title, description, tags, timestamp) and repair broken [[path/to/concept.md]] wiki-links after merges or deletions.
6. Refile clearly misplaced concepts into a fitting folder (create_concept at the new path with identical content, then delete_concept the old one).

Be conservative: when in doubt, leave a concept untouched.`,
		triggerType: 'event',
		triggerConfig: { event: 'memory.changed', every: 5 },
		enabled: true,
		toolAllowlist: [
			'search_memory',
			'read_concept',
			'list_concepts',
			'create_concept',
			'update_concept',
			'delete_concept'
		]
	});
}
