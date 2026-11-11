/**
 * The agents server's `start_agent` / `get_agent_run` calls, as the chat shows
 * them: one row per run with its status, the agent's reply and links to the run.
 */

import { isStoppedRun } from './agent-labels.js';
import { openAskUserCall } from './ask-user.js';
import type { AgentRun, AgentRunStatus } from './types.js';

export const AGENT_RUN_TOOLS: ReadonlySet<string> = new Set(['start_agent', 'get_agent_run']);

/** What the tool returned (see describeRunResult on the server). */
export interface AgentRunToolResult {
	run: AgentRun;
	/** Null in results from before the name was included; the row looks it up then. */
	agent: { id: string; name: string | null };
	runPath: string;
	chatPath: string | null;
	result: string | null;
	truncated: boolean;
	question: string | null;
}

const RUN_STATUSES: readonly AgentRunStatus[] = [
	'running',
	'success',
	'failed',
	'awaiting_input',
	'dismissed'
];

const rec = (v: unknown): Record<string, unknown> | null =>
	typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/** The tool's JSON result, from the MCP `content` text; null for errors and older results. */
export function parseAgentRunOutput(output: unknown): AgentRunToolResult | null {
	const out = rec(output);
	if (!out || out.isError === true || !Array.isArray(out.content)) return null;
	const first = rec(out.content[0]);
	const raw = typeof first?.text === 'string' ? first.text : null;
	if (!raw) return null;
	let body: Record<string, unknown> | null;
	try {
		body = rec(JSON.parse(raw));
	} catch {
		return null;
	}
	const run = rec(body?.run);
	if (!body || !run || typeof run.id !== 'string' || typeof run.agentId !== 'string') return null;
	if (!RUN_STATUSES.includes(run.status as AgentRunStatus)) return null;
	const agent = rec(body.agent);
	return {
		run: run as unknown as AgentRun,
		agent: { id: run.agentId, name: str(agent?.name) },
		runPath: str(body.runPath) ?? `/agents/${run.agentId}/runs/${run.id}`,
		chatPath: str(body.chatPath),
		result: str(body.result),
		truncated: body.truncated === true,
		question: str(body.question)
	};
}

/**
 * - `starting`: the call hasn't returned; the run is being started or waited on.
 * - `background`: the call returned while the run kept working on its own.
 * - `refused`: the tool turned the call down (unknown agent, not allowed…).
 * - `busy` / `wasBusy`: not started because a run of the agent was already
 *   working; the row follows that run instead, until it ends.
 */
export type AgentRunPhase =
	| 'starting'
	| 'running'
	| 'background'
	| 'done'
	| 'asking'
	| 'failed'
	| 'stopped'
	| 'dismissed'
	| 'refused'
	| 'busy'
	| 'wasBusy';

/** Runs that can still change: the row keeps following them. */
export function isRunOpen(status: AgentRun['status']): boolean {
	return status === 'running' || status === 'awaiting_input';
}

export function agentRunPhase(
	run: Pick<AgentRun, 'status' | 'error'> | null,
	opts: { callRunning: boolean }
): AgentRunPhase {
	if (!run) return opts.callRunning ? 'starting' : 'failed';
	switch (run.status) {
		case 'running':
			return opts.callRunning ? 'running' : 'background';
		case 'success':
			return 'done';
		case 'awaiting_input':
			return 'asking';
		case 'dismissed':
			return 'dismissed';
		default:
			return isStoppedRun(run) ? 'stopped' : 'failed';
	}
}

export const AGENT_RUN_PHASE_LABEL: Record<AgentRunPhase, string> = {
	starting: 'Starting',
	running: 'Running',
	background: 'Running',
	done: 'Done',
	asking: 'Needs your answer',
	failed: 'Failed',
	stopped: 'Stopped',
	dismissed: 'Dismissed',
	refused: "Couldn't start",
	busy: 'Already running',
	wasBusy: 'Not started'
};

/** Shorter labels for narrow screens, where the agent's name needs the room. */
export const AGENT_RUN_PHASE_SHORT_LABEL: Partial<Record<AgentRunPhase, string>> = {
	asking: 'Asking',
	busy: 'Busy'
};

/** The run's latest reply and open question, from its transcript (the run API's messages). */
export function latestRunReply(messages: readonly { role: string; parts: unknown[] }[]): {
	text: string | null;
	question: string | null;
} {
	const last = messages.at(-1);
	if (!last || last.role !== 'assistant') return { text: null, question: null };
	const parts = last.parts.filter((p): p is { type: string; text?: unknown } => !!rec(p));
	const text = parts
		.filter((p) => p.type === 'text' && typeof p.text === 'string')
		.map((p) => p.text as string)
		.join('\n')
		.trim();
	return { text: text || null, question: openAskUserCall(parts)?.question ?? null };
}

/**
 * Why the tool turned the call down, worded for the user (the tool's text is
 * written for the model), plus the run it points at when the agent is busy.
 */
export function describeRefusal(text: string): { reason: string; runId: string | null } {
	const reason = text.replace(/^error:\s*/i, '').trim();
	const busy = /already running \(run ([^)\s]+)\)/i.exec(reason);
	if (busy || /already running/i.test(reason)) {
		return {
			reason: 'Already running: a run of this agent hasn’t finished yet',
			runId: busy?.[1] ?? null
		};
	}
	return {
		reason: reason ? reason.charAt(0).toUpperCase() + reason.slice(1) : 'The call failed',
		runId: null
	};
}

/** The reply's first readable line, for the collapsed row. */
export function replyPreview(text: string | null): string | null {
	if (!text) return null;
	// A heading ("## This week") or a table says less than the first sentence; they are fallbacks.
	let fallback: string | null = null;
	for (const raw of text.split('\n')) {
		const line = raw
			.replace(/^\s*(?:#{1,6}\s+|[>*\-+]\s+|\d+[.)]\s+)/, '')
			.replace(/(\*\*|__|\*|_)(\S(?:.*?\S)?)\1/g, '$2')
			.replace(/`/g, '')
			.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
			.trim();
		if (!line || /^[-*_=|:\s]+$/.test(line)) continue;
		if (/^\s*#/.test(raw) || /^\s*\|/.test(raw)) {
			fallback ??= line.replace(/^\|\s*|\s*\|$/g, '').replace(/\s*\|\s*/g, ' · ');
			continue;
		}
		return line;
	}
	return fallback;
}
