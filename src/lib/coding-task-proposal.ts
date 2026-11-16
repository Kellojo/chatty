/**
 * The coding server's `propose_coding_task` call, as the chat shows it: a card
 * with the proposed task and a button that opens the hand-off dialog with it.
 * Nothing is started by the tool; the user reviews the task and starts it.
 */

import type { CodingConversation } from './coding-environments.js';

export const PROPOSE_CODING_TASK_TOOL = 'propose_coding_task';

/** A task started from a proposal, as `GET /api/coding/tasks?proposedIn=` lists it. */
export interface ProposedCodingTask {
	/** The `propose_coding_task` call it was started from. */
	toolCallId: string;
	conversationId: string;
	title: string;
	coding: CodingConversation;
}

/**
 * The notice the proposing chat gets when the task first finishes: an
 * assistant message with only this part. The model reads it as text.
 */
export const CODING_TASK_NOTICE_PART = 'data-coding-task-notice';

export interface CodingTaskNotice {
	conversationId: string;
	title: string;
	projectTitle: string;
	status: 'completed' | 'failed' | 'interrupted';
	branch: string | null;
	prUrl: string | null;
}

export function readCodingTaskNotice(part: { type: string }): CodingTaskNotice | null {
	if (part.type !== CODING_TASK_NOTICE_PART) return null;
	const data = (part as { data?: unknown }).data;
	if (typeof data !== 'object' || data === null) return null;
	const n = data as Record<string, unknown>;
	const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
	const conversationId = str(n.conversationId);
	const status = n.status;
	if (
		!conversationId ||
		(status !== 'completed' && status !== 'failed' && status !== 'interrupted')
	) {
		return null;
	}
	return {
		conversationId,
		title: str(n.title) ?? 'Coding task',
		projectTitle: str(n.projectTitle) ?? 'its project',
		status,
		branch: str(n.branch),
		prUrl: str(n.prUrl)
	};
}

const NOTICE_VERB: Record<CodingTaskNotice['status'], string> = {
	completed: 'finished',
	failed: 'failed',
	interrupted: 'was interrupted'
};

/** The notice in words: what the chat's model reads, and the notice row's headline. */
export function codingTaskNoticeText(n: CodingTaskNotice): string {
	const details = [
		n.branch ? `branch ${n.branch}` : null,
		n.prUrl ? `pull request ${n.prUrl}` : null
	].filter(Boolean);
	return (
		`Coding task "${n.title}" in ${n.projectTitle} ${NOTICE_VERB[n.status]}` +
		(details.length ? ` (${details.join(', ')})` : '') +
		`. Its chat id is ${n.conversationId}; read_chat shows what it did.`
	);
}

/** Whether a message is only a coding task notice (no reply actions, not a reply). */
export function isCodingTaskNoticeMessage(message: { parts: { type: string }[] }): boolean {
	return (
		message.parts.length > 0 &&
		message.parts.every((p) => p.type === CODING_TASK_NOTICE_PART || p.type === 'step-start')
	);
}

/** The project the proposal names, as the tool checked it (ids plus names to show). */
export interface CodingTaskProposalTarget {
	environmentId: string;
	environmentName: string;
	projectId: string;
	projectTitle: string;
}

export interface CodingTaskProposal {
	title: string | null;
	prompt: string;
	/** Preselected in the dialog; the user can still pick another. */
	target?: CodingTaskProposalTarget | null;
	/** The call it came from: the started task is linked to it (once per proposal). */
	source?: { conversationId: string; toolCallId: string } | null;
}

/** The checked target from the tool's result (its MCP `content` text); null when none. */
export function parseCodingTaskProposalTarget(output: unknown): CodingTaskProposalTarget | null {
	if (typeof output !== 'object' || output === null) return null;
	const content = (output as { content?: unknown }).content;
	const raw = Array.isArray(content) ? (content[0] as { text?: unknown } | undefined)?.text : null;
	if (typeof raw !== 'string') return null;
	try {
		const target = (JSON.parse(raw) as { target?: unknown }).target as
			Record<string, unknown> | null | undefined;
		if (!target || typeof target !== 'object') return null;
		const { environmentId, environmentName, projectId, projectTitle } = target;
		if (
			typeof environmentId !== 'string' ||
			typeof projectId !== 'string' ||
			typeof environmentName !== 'string' ||
			typeof projectTitle !== 'string'
		) {
			return null;
		}
		return { environmentId, environmentName, projectId, projectTitle };
	} catch {
		return null;
	}
}

/** Whether a message part is a `propose_coding_task` call (shown inline, not as activity). */
export function isCodingTaskProposalPart(part: { type: string; toolName?: string }): boolean {
	const name =
		part.type === 'dynamic-tool'
			? part.toolName
			: part.type.startsWith('tool-')
				? part.type.slice(5)
				: null;
	return name === PROPOSE_CODING_TASK_TOOL;
}

/** The call's arguments; null while the prompt hasn't arrived (or is empty). */
export function parseCodingTaskProposal(input: unknown): CodingTaskProposal | null {
	if (typeof input !== 'object' || input === null) return null;
	const { title, prompt } = input as { title?: unknown; prompt?: unknown };
	if (typeof prompt !== 'string' || !prompt.trim()) return null;
	return {
		title: typeof title === 'string' && title.trim() ? title.trim() : null,
		prompt: prompt.trim()
	};
}
