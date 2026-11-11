import { openAskUserCall } from '$lib/ask-user.js';
import type { AgentRun } from '$lib/types.js';
import type { Db } from '../db/index.js';
import { getAgentRun, toPublic, type AgentRunRow } from '../db/repo/agent-runs.js';
import { extractText, listLatestMessages } from '../db/repo/messages.js';
import { subscribeServerEvents } from '../events/bus.js';

/** The longest a tool call blocks on a run before handing back a still-running run. */
export const RUN_WAIT_MAX_MS = 10 * 60_000;

/** The reply text handed back to the calling model is capped so a long report can't flood its context. */
export const RUN_RESULT_MAX_CHARS = 8_000;

/**
 * Resolves with the run once it is no longer `running` (finished, failed, or
 * waiting on the user's answer), or with the still-running run after
 * `timeoutMs` or when `signal` aborts. Coding agent runs settle when their
 * task's thread finishes, so the wait covers them too.
 */
export function waitForRunToSettle(
	db: Db,
	run: AgentRunRow,
	{ timeoutMs, signal }: { timeoutMs: number; signal?: AbortSignal }
): Promise<AgentRunRow> {
	return new Promise((resolve) => {
		const cleanups: (() => void)[] = [];
		const finish = () => {
			for (const cleanup of cleanups.splice(0)) cleanup();
			// A run deleted mid-wait (with its agent) hands back what was last known.
			resolve(getAgentRun(db, run.id) ?? run);
		};
		// Subscribed before the status check, so a run that ends in between isn't missed.
		cleanups.push(
			subscribeServerEvents(run.user_id, (_, event) => {
				if (event.type === 'agent.run.finished' && event.runId === run.id) finish();
			})
		);
		const current = getAgentRun(db, run.id);
		if (!current || current.status !== 'running' || signal?.aborted) return finish();
		const timer = setTimeout(finish, timeoutMs);
		cleanups.push(() => clearTimeout(timer));
		if (signal) {
			signal.addEventListener('abort', finish, { once: true });
			cleanups.push(() => signal.removeEventListener('abort', finish));
		}
	});
}

export interface RunResult {
	run: AgentRun;
	agent: { id: string; name: string };
	/** The run's page, with its live transcript. */
	runPath: string;
	/** The chat to answer the run's question in (runs that may ask are visible chats). */
	chatPath: string | null;
	/** The run's final reply, once it has one. */
	result: string | null;
	/** Whether `result` was cut to RUN_RESULT_MAX_CHARS. */
	truncated?: boolean;
	/** The question an `awaiting_input` run waits on. */
	question: string | null;
	/** What the calling model should do next. */
	note: string;
}

/** The run as a tool result: its status and, once it has one, what the agent replied. */
export function describeRunResult(
	db: Db,
	row: AgentRunRow,
	agent: { id: string; name: string },
	opts: { visible: boolean }
): RunResult {
	const last = row.conversation_id
		? listLatestMessages(db, row.conversation_id, 1).find((m) => m.role === 'assistant')
		: undefined;
	const parts = last ? (JSON.parse(last.parts) as { type: string }[]) : [];
	const question =
		row.status === 'awaiting_input' ? (openAskUserCall(parts)?.question ?? null) : null;
	const reply = row.status === 'running' ? '' : extractText(parts).trim();
	const truncated = reply.length > RUN_RESULT_MAX_CHARS;
	const chatPath = opts.visible && row.conversation_id ? `/chat/${row.conversation_id}` : null;
	return {
		run: toPublic(row),
		agent,
		runPath: `/agents/${agent.id}/runs/${row.id}`,
		chatPath,
		result: reply ? (truncated ? `${reply.slice(0, RUN_RESULT_MAX_CHARS)}…` : reply) : null,
		...(truncated ? { truncated: true } : {}),
		question,
		note: noteFor(row.status)
	};
}

function noteFor(status: string): string {
	switch (status) {
		case 'running':
			return 'The run is still working. Call get_agent_run with wait: true to keep waiting, or tell the user it runs in the background.';
		case 'awaiting_input':
			return "The agent stopped to ask the user a question. Relay it; the user answers in the run's chat (chatPath).";
		case 'success':
			return 'The run finished. Summarise its result for the user.';
		case 'dismissed':
			return 'The run was dismissed before it finished.';
		default:
			return 'The run failed; see run.error.';
	}
}
