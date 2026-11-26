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
3. Before writing, find where each fact belongs: list_concepts, then search_memory with the subject's distinctive words. If a note covers the subject, read_concept it and update_concept it. Create a note only for a subject no note covers; if create_concept answers with "possibly related" notes, read them and merge if one is about the same subject.
4. Persist only what will still matter in a month and that the user would expect you to know: facts about the user, their preferences, their decisions (with the reason), and the goal and current state of their ongoing projects. Never transient chatter, one-off questions or secrets.

What to leave out:
- Anything the assistant or a coding agent produced: designs, option lists, research results, benchmarks, step-by-step advice, progress reports. Keep only what the user decided or asked for, in a line, plus a link if the result was saved somewhere.
- Engineering detail that the repository already records: commit hashes, PR and migration numbers, test counts, lint or typecheck results, branch names, file paths. In coding chats, read the user's requests and the final outcome, not the agent's narration.
- Guesses: never infer a name, gender or other personal detail from a username, file path or device name. Refer to the user as "the user" unless they told you their name.

How to write:
- One note per subject (a person, project, feature, preference or decision), never per chat, day or work session: no dates or "wave"/"session" in paths or titles.
- Each fact lives in exactly one note. An overview note sums its subject up in a few lines and links to the detailed notes; it doesn't repeat their details or status.
- When a fact changes, rewrite the sentence that holds it and delete what the change made wrong. Never add "Update (date)" sections or keep a history; the newest state is the note.
- Keep notes short: a body of a few short sections, well under 2,500 characters. A description of one plain sentence (max 200 characters) saying what the note is about, without dates, versions or status. At most 6 lowercase tags someone would search for. A new note that doesn't fit, or an update that makes a note break them further, is refused with the reason: fix what it names and call again. If durable facts don't fit in one note, split them into one note per subject rather than cutting facts.

Arguments of create_concept / update_concept:
- path: folder/subject.md, e.g. people/…, projects/…, preferences/…
- type: concept | person | project | preference | decision
- title: short human-readable name of the subject
- description: the one sentence above
- tags: up to 6 lowercase keywords
- body: markdown only, no frontmatter (the tools write it from the other arguments and set the timestamp). Cross-link related notes with [[path/to/concept.md]] wiki-links to notes that exist.

Example call about a made-up user, NOT a fact about this user: never create this note. Copy its shape and length only; your notes are about the user's own subjects, written from what they said, within the limits above:
create_concept(
  path: "preferences/example-tea.md",
  type: "preference",
  title: "Tea (example)",
  description: "How the example user likes their tea.",
  tags: ["tea", "drinks"],
  body: "- Green tea, never with sugar.\\n- Brews it at 80 °C for two minutes (\\"bitter otherwise\\").\\n\\nRelated: [[preferences/example-food.md]]"
)`;

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
2. Merge duplicates: notes about the same subject under different names (a project and its alias, a person filed twice, one feature split over a plan note and a build note) become one. update_concept the keeper with the combined facts, delete_concept the other, and point wiki-links at the keeper.
3. One place per fact: an overview note keeps a few-line summary and links; delete details and status it repeats from the notes it links to. Notes named after a chat, day or work session: move each fact into the note of its subject, then delete the session note.
4. Resolve contradictions: when notes disagree, keep the newest fact (judge by the content: a fact that names a later outcome replaces one that says it is still planned or pending), rewrite the stale sentence, and delete "Update (date)" sections once their content is folded in. Status like "pending", "uncommitted", "in progress" or "as of …" that a newer note contradicts is outdated: fix it.
5. Cut noise: remove commit hashes, PR and migration numbers, test counts, branch names and file paths; assistant-produced designs, option lists and research that the user didn't adopt; and guesses about the user (a name taken from a username or file path). Delete a note when nothing durable is left. Never delete a unique durable fact about the user, a preference, or a decision.
6. Tidy the fields (update_concept takes title, type, description, tags and body; the body never holds frontmatter): a description of one plain sentence (max 200 characters, no dates, versions or status), at most 6 lowercase tags, and a body under 2,500 characters; the memory tools refuse new notes that don't fit and updates that make a note worse. Older notes may still break the limits: when you rewrite one, bring it within them. Repair broken [[path/to/concept.md]] wiki-links.
7. Refile clearly misplaced notes into a fitting folder:
   a. create_concept at the new path. The "possibly related" hint will name the old note; that's expected.
   b. If it's refused for being over the limits, reword and shorten the note (it needn't match the old one word for word) and create it again. If shortening would drop durable facts, create one note per subject instead.
   c. delete_concept the old note once its facts are in the new note(s).

Make every fix you're confident about; leave a note untouched only when you can't tell whether a change would lose a durable fact. Work through the problems your survey (or the subagents' reports) found, merges first, then the rest, and finish once each is fixed or left on purpose; don't start a new survey within the run.`;

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
