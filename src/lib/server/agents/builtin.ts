import { MAX_CONCURRENT_SUBAGENTS, RUN_SUBAGENT_TOOL } from '$lib/subagent-tool.js';
import type { AgentTriggerConfig } from '$lib/types.js';
import type { Db } from '../db/index.js';
import { createAgent, updateAgent, type AgentRow } from '../db/repo/agents.js';
import type { TurnToolLimits } from '../chat/service.js';

export const MEMORY_EXTRACTION_AGENT = 'memory-extraction';
export const MEMORY_CLEANUP_AGENT = 'memory-cleanup';

const EXTRACTION_TRIGGER_CONFIG: AgentTriggerConfig = {
	event: 'chat.created',
	every: 5,
	instructions:
		'New chats have been created since the last extraction. Use search_chats with the "since" parameter to list recent conversations, read_chat to review their contents, then distill durable long-term memory from them.'
};

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

const EXTRACTION_SYSTEM_PROMPT = `You are the memory extraction agent. Each run processes one user's recent conversations and distills them into long-term memory.

Workflow:
1. Use search_chats to find recent conversations.
2. Read them. read_chat returns one page at a time; follow its cursors until you have read what is new. Several chats or a long one: hand each chat to its own run_subagent with tools ["read_chat"] (up to ${MAX_CONCURRENT_SUBAGENTS} at once), giving it the chat id and the time window, and asking it to read the whole chat with from = "start" and newerCursor and to report the durable facts, preferences, decisions and ongoing projects it finds — concise bullets, no chatter. Their reports, not the chats, then stay in your context. Read a single short chat yourself.
3. Check existing memory with list_concepts and search_memory; prefer update_concept over create_concept when a concept already exists.
4. Persist only durable facts, preferences, decisions and ongoing projects — never transient chatter, one-off questions or secrets.

Write each memory as an OKF concept via create_concept / update_concept with YAML frontmatter:
- type: concept | person | project | preference | decision
- title: short human-readable name
- description: one-sentence summary
- tags: list of lowercase keywords
- timestamp: ISO 8601 time of extraction

The body is structured markdown. Cross-link related concepts with [[path/to/concept.md]] wiki-links so the memory graph stays connected.`;

const EXTRACTION_TOOLS = [
	'search_chats',
	'read_chat',
	RUN_SUBAGENT_TOOL,
	'search_memory',
	'read_concept',
	'list_concepts',
	'create_concept',
	'update_concept',
	'delete_concept'
];

interface BuiltinAgentDefinition {
	name: string;
	description: string;
	systemPrompt: string;
	triggerConfig: AgentTriggerConfig;
	toolAllowlist: string[];
}

/**
 * Creates a built-in event agent, or brings an existing row up to date: users
 * can't edit built-ins, so their description, trigger, prompt and tools follow
 * this code. Whether they're enabled is left alone.
 */
function syncBuiltinAgent(db: Db, def: BuiltinAgentDefinition): void {
	const existing = db
		.prepare(
			'SELECT id, description, trigger_type, trigger_config, system_prompt, tool_allowlist FROM agents WHERE name = ? AND user_id IS NULL'
		)
		.get(def.name) as
		| {
				id: string;
				description: string;
				trigger_type: string;
				trigger_config: string;
				system_prompt: string;
				tool_allowlist: string | null;
		  }
		| undefined;
	if (!existing) {
		createAgent(db, null, {
			name: def.name,
			description: def.description,
			systemPrompt: def.systemPrompt,
			triggerType: 'event',
			triggerConfig: def.triggerConfig,
			enabled: true,
			toolAllowlist: def.toolAllowlist
		});
		return;
	}
	const triggerChanged =
		existing.trigger_type !== 'event' ||
		existing.trigger_config !== JSON.stringify(def.triggerConfig);
	if (
		triggerChanged ||
		existing.description !== def.description ||
		existing.system_prompt !== def.systemPrompt ||
		existing.tool_allowlist !== JSON.stringify(def.toolAllowlist)
	) {
		updateAgent(db, existing.id, {
			description: def.description,
			systemPrompt: def.systemPrompt,
			toolAllowlist: def.toolAllowlist,
			...(triggerChanged
				? { triggerType: 'event' as const, triggerConfig: def.triggerConfig, nextRunAt: null }
				: {})
		});
	}
}

export function seedBuiltinAgent(db: Db): void {
	syncBuiltinAgent(db, {
		name: MEMORY_EXTRACTION_AGENT,
		description: 'Extracts long-term memory from recent conversations (built-in).',
		systemPrompt: EXTRACTION_SYSTEM_PROMPT,
		triggerConfig: EXTRACTION_TRIGGER_CONFIG,
		toolAllowlist: EXTRACTION_TOOLS
	});
}

/**
 * What an event-triggered cleanup run is told, whatever changes triggered it:
 * the run reviews the bundle, and an event's note path would otherwise reach
 * both of its passes.
 */
export const CLEANUP_EVENT_INSTRUCTIONS =
	'Memory has changed since your last run. Survey the bundle and tidy it according to your role.';

const CLEANUP_SYSTEM_PROMPT = `You are the memory cleanup agent. Each run processes one user's long-term memory bundle and keeps it accurate and tidy. You are triggered after memories change.

Workflow:
1. Survey the bundle with list_concepts (titles and descriptions), then read_concept the concepts that look duplicated, contradictory, stale or misfiled, and their neighbors. A large bundle: split the review by folder or topic and hand each part to its own run_subagent with tools ["list_concepts", "read_concept", "search_memory"] (up to ${MAX_CONCURRENT_SUBAGENTS} at once). Ask each to read its part and report, with concept paths, the duplicates, contradictions, noise, broken wiki-links and metadata problems it finds, plus the fix it proposes. Subagents only review; you make every change yourself, so changes that span parts stay consistent.
2. Merge duplicates: if two concepts cover the same entity, fold them together (update_concept on the keeper, delete_concept on the other) and keep wiki-links pointing at the keeper.
3. Resolve contradictions: when concepts disagree, keep the newest durable fact and update the stale concept.
4. Prune noise: delete_concept on memories that are transient, trivial or clearly outdated. Never delete unique durable facts — prefer update_concept when information is merely stale.
5. Tidy metadata: fix missing or messy frontmatter (type, title, description, tags, timestamp) and repair broken [[path/to/concept.md]] wiki-links after merges or deletions.
6. Refile clearly misplaced concepts into a fitting folder (create_concept at the new path with identical content, then delete_concept the old one).

Be conservative: when in doubt, leave a concept untouched.`;

export function seedMemoryCleanupAgent(db: Db): void {
	syncBuiltinAgent(db, {
		name: MEMORY_CLEANUP_AGENT,
		description:
			'Keeps long-term memory tidy on every 5th memory change: merges duplicates, resolves contradictions, prunes noise, and marks notes with personal information private (built-in).',
		systemPrompt: CLEANUP_SYSTEM_PROMPT,
		triggerConfig: { event: 'memory.changed', every: 5 },
		toolAllowlist: [
			'search_memory',
			'read_concept',
			'list_concepts',
			RUN_SUBAGENT_TOOL,
			'create_concept',
			'update_concept',
			'delete_concept'
		]
	});
}

/** The built-in memory agents (extraction and cleanup), which run per pass. */
export function isBuiltinMemoryAgent(agent: Pick<AgentRow, 'user_id' | 'name'>): boolean {
	return (
		agent.user_id === null &&
		(agent.name === MEMORY_EXTRACTION_AGENT || agent.name === MEMORY_CLEANUP_AGENT)
	);
}

/**
 * Which part of memory a memory agent's run works on (design C7):
 * - public: the non-private view, like an untrusted turn, so what it writes
 *   stays public. The only pass on a memory model that isn't trusted.
 * - private: only private chats and private concepts; tainted from the start
 *   (its conversation is private), so everything it writes is private. Only
 *   on a trusted memory model.
 * Without the split, sticky taint would make every concept written after the
 * first private read private, including those from public chats.
 */
export type MemoryPass = 'public' | 'private';

/**
 * The turn limits of a pass. `trust` caps the turn's trust and `privateOnly`
 * narrows its data tools to private items; both are read by chat/service.ts
 * (TurnToolLimits) and passed on to the tools' CallerContext.
 */
export function memoryPassLimits(pass: MemoryPass): TurnToolLimits {
	return pass === 'public' ? { trust: 'untrusted' } : { tainted: true, privateOnly: true };
}

/** Appended to a private pass's instructions. */
export const PRIVATE_PASS_NOTE =
	'This is the private pass: you only see the user’s private chats and private memory concepts, and everything you write is saved as private. Public chats and concepts are handled by a separate pass; leave them alone.';

/**
 * Start time of the latest successful run of this pass. Each pass keeps its
 * own extraction window, so one failing doesn't make the other skip chats.
 * A run's pass is its conversation's privacy (a deleted one counts as public).
 */
export function lastSuccessfulMemoryPassAt(
	db: Db,
	agentId: string,
	userId: string,
	pass: MemoryPass
): number | null {
	const row = db
		.prepare(
			`SELECT MAX(r.started_at) AS at FROM agent_runs r
			 LEFT JOIN conversations c ON c.id = r.conversation_id
			 WHERE r.agent_id = ? AND r.user_id = ? AND r.status = 'success'
			   AND COALESCE(c.private, 0) = ?`
		)
		.get(agentId, userId, pass === 'private' ? 1 : 0) as { at: number | null };
	return row.at;
}
