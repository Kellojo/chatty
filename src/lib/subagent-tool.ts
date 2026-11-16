/** The subagents server's `run_subagent` tool, shared by the server and the chat's subagent row. */

export const RUN_SUBAGENT_TOOL = 'run_subagent';

/** Subagents one conversation may have working at once (local models serve few requests in parallel). */
export const MAX_CONCURRENT_SUBAGENTS = 4;

/** The prefix of a subagent conversation's title; the rest is the task's description. */
export const SUBAGENT_TITLE_PREFIX = 'Subagent · ';

/**
 * Ends a report that was cut to fit the tool result. The model reads it; the
 * chat's row shows its own note instead.
 */
export const REPORT_CUT_MARKER = '[Report shortened here; the transcript has all of it.]';

/** The report without the cut marker, for showing it to the user. */
export function displayReport(report: string): string {
	return report.endsWith(REPORT_CUT_MARKER)
		? report.slice(0, -REPORT_CUT_MARKER.length).trimEnd()
		: report;
}

/** What the tool returns (JSON in its MCP text content). */
export interface SubagentToolResult {
	status: 'completed' | 'failed' | 'stopped';
	result: string | null;
	truncated: boolean;
	error: string | null;
	conversationId: string;
	/** ms since epoch; absent in results from before they were recorded. */
	startedAt?: number;
	endedAt?: number;
	/** Requested tools the parent doesn't have, so the subagent didn't get them. */
	droppedTools?: string[];
}

/** A subagent as the transcript page and the chat's row see it. */
export interface SubagentInfo {
	id: string;
	description: string;
	/** The conversation that started it (its chat, when it's one the user sees). */
	parentId: string;
	parentTitle: string;
	/** Whether the parent is a chat the user can open (agent runs are not). */
	parentIsChat: boolean;
	status: 'running' | 'completed' | 'failed' | 'stopped';
	startedAt: number;
	/** When its last message was written; null while it's running. */
	endedAt: number | null;
	error: string | null;
	/** While it runs: how many tool steps it took and the latest one, in words. */
	progress: { steps: number; current: string | null } | null;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** The tool's JSON result, from the MCP `content` text; null for refusals and other shapes. */
export function parseSubagentToolResult(output: unknown): SubagentToolResult | null {
	const content = (output as { content?: unknown } | null)?.content;
	const raw = Array.isArray(content) ? (content[0] as { text?: unknown } | undefined)?.text : null;
	if (typeof raw !== 'string') return null;
	try {
		const body = JSON.parse(raw) as Record<string, unknown>;
		if (typeof body.conversationId !== 'string') return null;
		if (body.status !== 'completed' && body.status !== 'failed' && body.status !== 'stopped') {
			return null;
		}
		return {
			status: body.status,
			result: typeof body.result === 'string' ? body.result : null,
			truncated: body.truncated === true,
			error: typeof body.error === 'string' ? body.error : null,
			conversationId: body.conversationId,
			startedAt: num(body.startedAt),
			endedAt: num(body.endedAt),
			droppedTools: Array.isArray(body.droppedTools)
				? body.droppedTools.filter((t): t is string => typeof t === 'string')
				: undefined
		};
	} catch {
		return null;
	}
}
