// Subagents: a chat (or an agent run) hands one task to a fresh assistant that
// works in its own hidden conversation and reports back with its final reply.
// The work (tool calls, fetched pages, reasoning) stays out of the parent's
// context; only the report comes back. A subagent gets the parent's tools or
// fewer, its model, memory setting and workspace, and can't start subagents
// or ask the user anything.

import { isConversationPrivate, isPrivateContext, type Privacy } from '../privacy/policy.js';
import { isTurnPrivacy } from '../privacy/taint.js';
import { randomUUID } from 'node:crypto';
import type { UIMessage } from 'ai';
import { getDb, type Db } from '../db/index.js';
import {
	createConversation,
	getConversation,
	type ConversationRow
} from '../db/repo/conversations.js';
import { extractText, listLatestMessages } from '../db/repo/messages.js';
import { createLogger } from '../logger.js';
import { BASE_PROMPT } from '../llm/systemPrompt.js';
import { abortStream } from '../chat/streams.js';
import { conversationToolAllowlist, runChatTurnHeadless } from '../chat/service.js';
import { ASK_USER_TOOL } from '../tools/askUser.js';
import {
	MAX_CONCURRENT_SUBAGENTS,
	REPORT_CUT_MARKER,
	RUN_SUBAGENT_TOOL,
	SUBAGENT_TITLE_PREFIX,
	type SubagentInfo,
	type SubagentToolResult
} from '$lib/subagent-tool.js';
import { describeTool } from '$lib/tool-meta.js';

const log = createLogger('subagents');
/** Longest report handed back; the transcript keeps all of it. */
export const SUBAGENT_RESULT_MAX_CHARS = 8_000;

const SUBAGENT_PROMPT = `${BASE_PROMPT}

You are a subagent: another assistant handed you a single task. Do it with your tools, then reply with a final report.
- Your final message is the only thing the requester sees, so make it self-contained: what you found or did, with the concrete details that matter (names, numbers, file paths, links, sources). No preamble, no offers of further help.
- Nobody can answer questions: when something is unclear, make a reasonable assumption and say which.
- Stay within the task. If it can't be done, say why and what you tried.`;

export class SubagentError extends Error {}

export interface SubagentInput {
	userId: string;
	/** The conversation that starts it (a chat or an agent run's). */
	parentConversationId: string;
	/** Short label for the transcript's title. */
	description: string;
	prompt: string;
	/** Narrows the subagent's tools further; never adds any the parent lacks. */
	tools?: string[];
	/** The parent's `run_subagent` call, so its row can find the subagent while it works. */
	toolCallId?: string;
	signal?: AbortSignal;
	/**
	 * The parent turn's privacy: a parent holding private data starts a private,
	 * tainted subagent, and a subagent that read private data taints the parent.
	 */
	parentPrivacy?: Privacy;
}

/** What a parent that may not see private data gets instead of a private subagent's report. */
export const PRIVATE_REPORT_WITHHELD =
	"The subagent's report is private: it read private data this chat's model may not see. Open it in Chatty.";

/** The report the tool returns; `result` is shortened to SUBAGENT_RESULT_MAX_CHARS. */
export type SubagentResult = SubagentToolResult;

// Kept on globalThis so a dev-server reload doesn't forget the subagents that are running.
const globalState = globalThis as {
	__runningSubagents?: Map<string, number>;
	__subagentsInFlight?: Set<string>;
};
/** Running subagents per parent conversation. */
const running = (globalState.__runningSubagents ??= new Map<string, number>());
/** The conversations of subagents that are running now. */
const inFlight = (globalState.__subagentsInFlight ??= new Set<string>());

const descriptionOf = (title: string) =>
	title.startsWith(SUBAGENT_TITLE_PREFIX) ? title.slice(SUBAGENT_TITLE_PREFIX.length) : title;

const ENDINGS: ReadonlySet<string> = new Set(['completed', 'failed', 'stopped']);

/**
 * What a running subagent is doing, from its reply as stored so far (the chat
 * engine writes it as it streams): its tool steps and the latest, in words.
 */
function progressOf(db: Db, conversationId: string): SubagentInfo['progress'] {
	const last = listLatestMessages(db, conversationId, 1).find((m) => m.role === 'assistant');
	if (!last) return { steps: 0, current: null };
	let parts: { type: string; toolName?: string; input?: unknown }[];
	try {
		parts = JSON.parse(last.parts) as typeof parts;
	} catch {
		return { steps: 0, current: null };
	}
	const tools = parts.filter((p) => p.type === 'dynamic-tool' || p.type.startsWith('tool-'));
	const latest = tools.at(-1);
	if (!latest) return { steps: 0, current: null };
	const name = latest.type === 'dynamic-tool' ? (latest.toolName ?? 'tool') : latest.type.slice(5);
	const { label, detail } = describeTool(name, latest.input);
	return { steps: tools.length, current: detail ? `${label}: ${detail}` : label };
}

/** The subagent's state for its transcript page and the parent's row. */
export function describeSubagent(
	db: Db,
	userId: string,
	conversationId: string
): SubagentInfo | null {
	const row = getConversation(db, userId, conversationId);
	if (!row?.subagent_of) return null;
	const parent = db
		.prepare('SELECT title, kind FROM conversations WHERE id = ?')
		.get(row.subagent_of) as { title: string; kind: string } | undefined;
	const base = {
		id: row.id,
		description: descriptionOf(row.title),
		parentId: row.subagent_of,
		parentTitle: parent?.title || 'Chat',
		parentIsChat: parent?.kind === 'chat',
		startedAt: row.created_at
	};
	if (inFlight.has(row.id)) {
		return {
			...base,
			status: 'running',
			endedAt: null,
			error: null,
			progress: progressOf(db, row.id)
		};
	}
	if (row.subagent_status && ENDINGS.has(row.subagent_status)) {
		return {
			...base,
			status: row.subagent_status as SubagentInfo['status'],
			endedAt: row.subagent_ended_at ?? row.updated_at,
			error: row.subagent_error,
			progress: null
		};
	}
	// Not running and no recorded ending: the server stopped while it worked. (A
	// subagent is marked in flight in the same synchronous step that creates its
	// conversation, so a poll never sees one that is merely starting here.)
	return {
		...base,
		status: 'failed',
		endedAt: row.updated_at,
		error: 'Ended without a recorded result (the server may have restarted while it worked)',
		progress: null
	};
}

/** The subagent a parent's `run_subagent` call started, if it has started yet. */
export function findSubagentForToolCall(
	db: Db,
	userId: string,
	parentId: string,
	toolCallId: string
): SubagentInfo | null {
	const row = db
		.prepare(
			`SELECT id FROM conversations
			 WHERE subagent_of = ? AND subagent_tool_call_id = ? AND user_id = ? AND deleted_at IS NULL
			 ORDER BY created_at DESC LIMIT 1`
		)
		.get(parentId, toolCallId, userId) as { id: string } | undefined;
	return row ? describeSubagent(db, userId, row.id) : null;
}

/**
 * The subagent's allowlist: the requested tools the parent may use, or the
 * parent's own allowlist. Undefined only when neither limits anything.
 * `dropped` are requested names the parent doesn't have.
 */
export function subagentAllowlist(
	parent: string[] | undefined,
	requested: string[] | undefined
): { allowlist: string[] | undefined; dropped: string[] } {
	if (!requested) return { allowlist: parent, dropped: [] };
	const unique = [...new Set(requested)];
	if (!parent) return { allowlist: unique, dropped: [] };
	const allowed = new Set(parent);
	return {
		allowlist: unique.filter((name) => allowed.has(name)),
		dropped: unique.filter((name) => !allowed.has(name))
	};
}

/** `text` cut to at most `max` characters (plus a note) without splitting a surrogate pair. */
export function cutReport(text: string, max: number): { text: string; truncated: boolean } {
	if (text.length <= max) return { text, truncated: false };
	let end = max;
	const code = text.charCodeAt(end - 1);
	if (code >= 0xd800 && code <= 0xdbff) end -= 1;
	return {
		text: `${text.slice(0, end).trimEnd()}\n\n${REPORT_CUT_MARKER}`,
		truncated: true
	};
}

/**
 * Stores how the subagent ended; returns when. A failed write is logged, not
 * thrown: the report still reaches the parent, and the transcript page then
 * shows the subagent as interrupted.
 */
function recordEnding(
	db: Db,
	id: string,
	status: SubagentResult['status'],
	error: string | null
): number {
	const endedAt = Date.now();
	try {
		db.prepare(
			'UPDATE conversations SET subagent_status = ?, subagent_error = ?, subagent_ended_at = ? WHERE id = ?'
		).run(status, error, endedAt, id);
	} catch (e) {
		log.error('Could not record how a subagent ended', {
			conversationId: id,
			error: e instanceof Error ? e.message : String(e)
		});
	}
	return endedAt;
}

/** Runs a subagent to completion and returns its report. Throws SubagentError when it can't start. */
export async function runSubagent(input: SubagentInput, db: Db = getDb()): Promise<SubagentResult> {
	const parent = getConversation(db, input.userId, input.parentConversationId);
	if (!parent) throw new SubagentError('conversation not found');
	if (parent.subagent_of) throw new SubagentError('a subagent cannot start subagents');
	// The tools the parent's own turns get, by the same rule its turns use.
	const { allowlist, dropped } = subagentAllowlist(
		conversationToolAllowlist(db, parent),
		input.tools
	);
	if (input.tools && allowlist?.length === 0) {
		throw new SubagentError(
			`none of the requested tools (${dropped.join(', ')}) are yours to give; leave tools out to give the subagent all of yours`
		);
	}
	// Checked and claimed together, before anything that could yield.
	const busy = running.get(parent.id) ?? 0;
	if (busy >= MAX_CONCURRENT_SUBAGENTS) {
		throw new SubagentError(
			`${MAX_CONCURRENT_SUBAGENTS} subagents are already working for this conversation; wait for one to finish`
		);
	}
	running.set(parent.id, busy + 1);

	// The subagent runs the parent's model, so it is as trusted as the parent.
	const parentTainted =
		parent.private === 1 ||
		(input.parentPrivacy !== undefined && isPrivateContext(db, input.parentPrivacy));
	let conversation: ConversationRow | undefined;
	const onAbort = () => {
		if (conversation) abortStream(conversation.id, 'stopped');
	};
	try {
		conversation = createConversation(db, input.userId, {
			// Hidden like agent runs: no sidebar entry, no chat events, no agent triggers.
			kind: 'agent-run',
			title: `${SUBAGENT_TITLE_PREFIX}${input.description}`.slice(0, 200),
			providerId: parent.provider_id,
			modelId: parent.model_id,
			systemPrompt: SUBAGENT_PROMPT,
			maxSteps: parent.max_steps,
			memoryEnabled: parent.memory_enabled === 1,
			subagentOf: parent.id,
			subagentToolCallId: input.toolCallId ?? null,
			private: parentTainted
		});
		const { id, created_at: startedAt } = conversation;
		inFlight.add(id);
		input.signal?.addEventListener('abort', onAbort, { once: true });
		log.info('Subagent started', {
			conversationId: id,
			parentId: parent.id,
			tools: allowlist?.length ?? 'all'
		});
		const base = {
			conversationId: id,
			startedAt,
			...(dropped.length ? { droppedTools: dropped } : {})
		};

		// A parent stopped before the turn registered its stream: don't start it at all.
		if (input.signal?.aborted) {
			const error = 'Stopped before it started';
			const endedAt = recordEnding(db, id, 'stopped', error);
			return { ...base, status: 'stopped', result: null, truncated: false, error, endedAt };
		}
		const message: UIMessage = {
			id: randomUUID(),
			role: 'user',
			parts: [{ type: 'text', text: input.prompt }]
		};
		let outcome: Awaited<ReturnType<typeof runChatTurnHeadless>>;
		try {
			outcome = await runChatTurnHeadless(
				input.userId,
				conversation,
				{ message },
				{
					tools: {
						allowlist,
						exclude: [RUN_SUBAGENT_TOOL, ASK_USER_TOOL],
						tainted: parentTainted
					}
				}
			);
		} catch (e) {
			// Documented never to throw; if it does, the ending is still recorded.
			const error = e instanceof Error ? e.message : String(e);
			log.error('Subagent turn threw', { conversationId: id, error });
			const endedAt = recordEnding(db, id, 'failed', error);
			return { ...base, status: 'failed', result: null, truncated: false, error, endedAt };
		}
		const last = listLatestMessages(db, id, 1).find((m) => m.role === 'assistant');
		const reply = last ? extractText(JSON.parse(last.parts) as unknown[]).trim() : '';
		let report = cutReport(reply, SUBAGENT_RESULT_MAX_CHARS);
		// A subagent that read private data (its chat was promoted) taints the
		// parent before the report reaches the parent's model.
		if (isConversationPrivate(db, id) && !parentTainted) {
			if (isTurnPrivacy(input.parentPrivacy) && input.parentPrivacy.trusted) {
				input.parentPrivacy.markTainted('a subagent read private data');
			} else {
				report = { text: PRIVATE_REPORT_WITHHELD, truncated: false };
			}
		}
		const status: SubagentResult['status'] =
			outcome.status === 'complete'
				? 'completed'
				: outcome.status === 'aborted'
					? 'stopped'
					: 'failed';
		const error =
			status === 'completed'
				? null
				: status === 'stopped'
					? 'Stopped before it finished'
					: (outcome.error ?? 'The subagent failed');
		log.info('Subagent finished', { conversationId: id, status });
		return {
			...base,
			status,
			result: report.text || null,
			truncated: report.truncated,
			error,
			endedAt: recordEnding(db, id, status, error)
		};
	} finally {
		if (conversation) inFlight.delete(conversation.id);
		input.signal?.removeEventListener('abort', onAbort);
		const left = (running.get(parent.id) ?? 1) - 1;
		if (left > 0) running.set(parent.id, left);
		else running.delete(parent.id);
	}
}
