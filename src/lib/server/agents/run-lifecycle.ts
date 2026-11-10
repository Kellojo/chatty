// What a chat turn needs to know when it belongs to an agent run, and how the
// run is settled when the turn ends. Shared by the runner (dispatched runs) and
// the chat engine (a user's reply resuming a run that asked a question).
import { openAskUserCall } from '$lib/ask-user.js';
import type { AgentRunStatus } from '$lib/types.js';
import { config } from '../config.js';
import type { Db } from '../db/index.js';
import {
	dismissAgentRun,
	finishAgentRun,
	getAgentRunByConversation,
	getAwaitingAgentRunByConversation,
	hasOpenAgentQuestion,
	reopenAgentRun,
	type AgentRunRow
} from '../db/repo/agent-runs.js';
import { parseCanAsk, setAgentRunTimes, type AgentRow } from '../db/repo/agents.js';
import {
	settleConversation,
	unsettleConversation,
	type ConversationRow
} from '../db/repo/conversations.js';
import { publishServerEvent } from '../events/bus.js';
import { createLogger } from '../logger.js';
import type { AbortReason } from '../chat/streams.js';

const log = createLogger('agents');

/** How a chat turn ended (see `runChatTurn`). */
export interface TurnOutcome {
	status: 'complete' | 'failed' | 'aborted';
	error: string | null;
	abortReason: AbortReason | null;
	/** The question the reply ended on (an unanswered `ask_user` call), if any. */
	openAskUser: { toolCallId: string; question: string } | null;
}

/** A chat turn executed on behalf of an agent run. */
export interface RunTurnContext {
	runId: string;
	agentId: string;
	userId: string;
	/** Memory-write author: 'system' for built-ins, else 'agent:<id>'. */
	author: string;
	/** Appended to the system prompt: who is running, when, and whether to ask. */
	header: string;
	/** Whether the turn gets the `ask_user` tool. */
	askUser: boolean;
	/** Whether the run is a visible chat the user can reply to. */
	visible: boolean;
	/** The turn continues the run after the user answered its question. */
	resumed: boolean;
	/**
	 * The user started this turn (an answer, edit or regenerate) rather than
	 * Chatty dispatching it: they are in the conversation, so a success doesn't
	 * settle it away.
	 */
	userTurn: boolean;
}

export const SHUTDOWN_MESSAGE = 'Interrupted by server shutdown';

const ABORT_ERRORS: Record<AbortReason, string> = {
	superseded: 'Superseded by your message',
	stopped: 'Stopped by user',
	shutdown: SHUTDOWN_MESSAGE
};

/** Whether an agent's runs are visible chats (anything but 'never' asking). */
export function runsAsChats(agent: Pick<AgentRow, 'can_ask' | 'coding_target'>): boolean {
	return !agent.coding_target && parseCanAsk(agent) !== 'never';
}

/**
 * The run's part of the system prompt. Rebuilt for every turn of the run, so a
 * resumed run gets the current time and knows the user just answered.
 */
export function runHeader(
	agent: Pick<AgentRow, 'name' | 'can_ask'>,
	trigger: string,
	opts: { askUser: boolean; resumed: boolean }
): string {
	const now = new Date().toLocaleString('en-US', { timeZone: config.TZ });
	const lines = [
		'---',
		`You are running autonomously as the agent "${agent.name}" (trigger: ${trigger}). Current time: ${now} (${config.TZ}).`
	];
	if (opts.resumed) {
		lines.push(
			'The user has replied to your question; their answer is the latest message. Continue the task.'
		);
	}
	if (!opts.askUser) {
		lines.push('Do not ask the user questions; no one is watching live.');
	} else if (parseCanAsk(agent) === 'approvals') {
		lines.push(
			'No one is watching live: decide on your own. Only before an irreversible or risky action (deleting, sending, publishing, spending) call ask_user for approval with your recommendation, then stop; the reply continues this conversation.'
		);
	} else {
		lines.push(
			'No one is watching live. Do everything you can on your own first. If you are blocked or about to do something irreversible, call ask_user with one concise question and your recommendation, then stop; the reply continues this conversation.'
		);
	}
	return lines.join('\n');
}

export function runTurnContext(
	db: Db,
	agent: AgentRow,
	run: Pick<AgentRunRow, 'id' | 'user_id' | 'trigger'>,
	opts: { resumed: boolean; userTurn?: boolean }
): RunTurnContext {
	const visible = runsAsChats(agent);
	// One open question per agent: while another run waits for an answer, this
	// one works without asking.
	const askUser = visible && !hasOpenAgentQuestion(db, agent.id, run.user_id, run.id);
	return {
		runId: run.id,
		agentId: agent.id,
		userId: run.user_id,
		author: agent.user_id === null ? 'system' : `agent:${agent.id}`,
		header: runHeader(agent, run.trigger, { askUser, resumed: opts.resumed }),
		askUser,
		visible,
		resumed: opts.resumed,
		userTurn: opts.userTurn ?? opts.resumed
	};
}

// --- turns in flight ---------------------------------------------------------

interface ActiveRunTurn {
	conversationId: string;
	released: Promise<void>;
}

const activeRunTurns = new Map<string, ActiveRunTurn>();
let closed = false;

/** From now on, run turns are aborted as soon as they start (server shutdown). */
export function closeRunTurns(): void {
	closed = true;
}

export function runTurnsClosed(): boolean {
	return closed;
}

/** Records a run's turn as running in `conversationId`; call the result when it has ended. */
export function registerRunTurn(runId: string, conversationId: string): () => void {
	let release = () => {};
	const released = new Promise<void>((resolve) => (release = resolve));
	const entry = { conversationId, released };
	activeRunTurns.set(runId, entry);
	return () => {
		if (activeRunTurns.get(runId) === entry) activeRunTurns.delete(runId);
		release();
	};
}

export function activeRunTurn(runId: string): ActiveRunTurn | undefined {
	return activeRunTurns.get(runId);
}

export function listActiveRunTurns(): ActiveRunTurn[] {
	return [...activeRunTurns.values()];
}

// --- settling ----------------------------------------------------------------

function errorFor(outcome: TurnOutcome): string | null {
	if (outcome.status === 'aborted') {
		return outcome.abortReason ? ABORT_ERRORS[outcome.abortReason] : 'Stopped';
	}
	if (outcome.status === 'failed') return outcome.error ?? 'The run failed';
	return null;
}

type EndedRunStatus = Exclude<AgentRunStatus, 'running'>;

function statusFor(ctx: RunTurnContext, outcome: TurnOutcome): EndedRunStatus {
	if (outcome.status !== 'complete') return 'failed';
	return ctx.askUser && outcome.openAskUser ? 'awaiting_input' : 'success';
}

/**
 * Settles the run once its turn ended: records the status, announces it and
 * tidies the sidebar (a routine success needs no attention; only the agent's
 * latest failure stays in the active list). Never throws.
 */
export function completeRunTurn(
	db: Db,
	ctx: RunTurnContext,
	conversation: Pick<ConversationRow, 'id'>,
	outcome: TurnOutcome
): EndedRunStatus {
	let status = statusFor(ctx, outcome);
	try {
		let error = errorFor(outcome);
		const state = db
			.prepare('SELECT settled_at, deleted_at FROM conversations WHERE id = ?')
			.get(conversation.id) as { settled_at: number | null; deleted_at: number | null } | undefined;
		if (status === 'awaiting_input' && (!state || state.deleted_at !== null)) {
			// The chat went to the trash while the turn ran: nobody can answer there.
			status = 'dismissed';
			error = 'Dismissed: chat deleted';
		}
		finishAgentRun(db, ctx.runId, status, error);
		setAgentRunTimes(db, ctx.agentId, { lastRunAt: Date.now() });
		if (status === 'awaiting_input' && state?.settled_at != null) {
			// Settled while the turn ran: a new question needs the user, so the chat
			// comes back to the active list instead of waiting on the settled shelf.
			unsettleConversation(db, ctx.userId, conversation.id);
			publishServerEvent(ctx.userId, {
				type: 'conversation.settle_changed',
				conversationIds: [conversation.id],
				settled: false
			});
		}
		if (status === 'awaiting_input' && outcome.openAskUser) {
			publishServerEvent(ctx.userId, {
				type: 'agent.run.awaiting_input',
				agentId: ctx.agentId,
				runId: ctx.runId,
				conversationId: conversation.id,
				question: outcome.openAskUser.question
			});
		}
		if (ctx.visible) tidyDispatchedChats(db, ctx, conversation.id, status);
		publishServerEvent(ctx.userId, {
			type: 'agent.run.finished',
			agentId: ctx.agentId,
			runId: ctx.runId,
			status,
			conversationId: conversation.id,
			visible: ctx.visible
		});
	} catch (e) {
		log.error('Failed to settle agent run', {
			runId: ctx.runId,
			error: e instanceof Error ? e.message : String(e)
		});
		try {
			finishAgentRun(db, ctx.runId, 'failed', e instanceof Error ? e.message : String(e));
		} catch {
			// nothing more to do
		}
	}
	return status;
}

/**
 * Earlier failed runs of the agent whose chats the user never replied to: once
 * a newer run has ended, they no longer need to sit in the active list.
 */
function listStaleFailedDispatchedChats(
	db: Db,
	agentId: string,
	userId: string,
	exceptConversationId: string
): string[] {
	return (
		db
			.prepare(
				`SELECT DISTINCT c.id FROM conversations c
				 JOIN agent_runs r ON r.conversation_id = c.id
				 WHERE r.agent_id = ? AND r.user_id = ? AND r.status = 'failed'
				   AND c.origin = 'dispatch' AND c.settled_at IS NULL AND c.deleted_at IS NULL
				   AND c.id != ?
				   AND (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user') <= 1`
			)
			.all(agentId, userId, exceptConversationId) as { id: string }[]
	).map((r) => r.id);
}

function tidyDispatchedChats(
	db: Db,
	ctx: RunTurnContext,
	conversationId: string,
	status: AgentRunStatus
): void {
	const settled = listStaleFailedDispatchedChats(db, ctx.agentId, ctx.userId, conversationId);
	// A routine success needs no attention, but once the user has taken part
	// (answered, edited, regenerated) they are in the conversation: it stays
	// where they are looking.
	if (status === 'success' && !ctx.userTurn) settled.push(conversationId);
	for (const id of settled) settleConversation(db, ctx.userId, id, 'auto');
	if (settled.length > 0) {
		publishServerEvent(ctx.userId, {
			type: 'conversation.settle_changed',
			conversationIds: settled,
			settled: true
		});
	}
}

/**
 * Gives up on the question a dispatched chat waits on (the chat was settled,
 * deleted or the run stopped, or the question expired). Returns whether a
 * waiting run was dismissed.
 */
export function dismissRunQuestion(
	db: Db,
	userId: string,
	conversationId: string,
	reason: string
): boolean {
	const run = getAwaitingAgentRunByConversation(db, conversationId);
	if (!run || run.user_id !== userId) return false;
	return dismissRun(db, run, reason);
}

/** Why a run's question was dismissed when its chat was settled (undone by unsettling). */
export const SETTLED_DISMISS_REASON = 'Dismissed: chat settled';

/**
 * Keeps a dispatched chat's run in step with settling it: settling gives up on
 * the question the run waits on. Call after the conversation was settled.
 */
export function onRunConversationSettled(db: Db, userId: string, conversationId: string): void {
	dismissRunQuestion(db, userId, conversationId, SETTLED_DISMISS_REASON);
}

/**
 * The counterpart of `onRunConversationSettled`: bringing the chat back puts a
 * question that settling dismissed back to waiting, as long as it is still the
 * chat's latest message and the agent has no other question open. Questions
 * dismissed any other way (stopped, expired) stay dismissed. Returns whether
 * the run waits again.
 */
export function onRunConversationUnsettled(
	db: Db,
	userId: string,
	conversationId: string
): boolean {
	const run = getAgentRunByConversation(db, conversationId);
	if (
		!run ||
		run.user_id !== userId ||
		run.status !== 'dismissed' ||
		run.error !== SETTLED_DISMISS_REASON
	) {
		return false;
	}
	// The shown branch's last message (its leaf); the newest message without one.
	const latest = db
		.prepare(
			`SELECT m.role, m.parts FROM messages m
			 WHERE m.conversation_id = ?
			   AND m.id = COALESCE(
			     (SELECT active_leaf_id FROM conversations WHERE id = ?),
			     (SELECT id FROM messages WHERE conversation_id = ?
			      ORDER BY created_at DESC, rowid DESC LIMIT 1)
			   )`
		)
		.get(conversationId, conversationId, conversationId) as
		{ role: string; parts: string } | undefined;
	let question: ReturnType<typeof openAskUserCall>;
	try {
		question = latest?.role === 'assistant' ? openAskUserCall(JSON.parse(latest.parts)) : null;
	} catch {
		question = null;
	}
	if (!question || hasOpenAgentQuestion(db, run.agent_id, userId, run.id)) return false;
	if (!reopenAgentRun(db, run.id)) return false;
	publishServerEvent(userId, {
		type: 'agent.run.finished',
		agentId: run.agent_id,
		runId: run.id,
		status: 'awaiting_input',
		conversationId,
		visible: true
	});
	return true;
}

export function dismissRun(db: Db, run: AgentRunRow, reason: string): boolean {
	if (!dismissAgentRun(db, run.id, reason)) return false;
	publishServerEvent(run.user_id, {
		type: 'agent.run.finished',
		agentId: run.agent_id,
		runId: run.id,
		status: 'dismissed',
		conversationId: run.conversation_id ?? undefined,
		visible: true
	});
	return true;
}
