// Coding tasks proposed in a chat (`propose_coding_task`) and started by the
// user: the chat's model sees each proposal's task and status, and the chat
// gets a notice when the task first finishes.

import {
	CODING_TASK_NOTICE_PART,
	codingTaskNoticeText,
	isCodingTaskProposalPart,
	readCodingTaskNotice,
	type CodingTaskNotice
} from '$lib/coding-task-proposal.js';
import type { ServerEvent, UIMessage } from '$lib/types.js';
import { getDb, type Db } from '../db/index.js';
import {
	claimProposalReport,
	getCodingConversation,
	listProposedCodingTasks,
	type CodingConversationRow
} from '../db/repo/coding-conversations.js';
import { getConversation, touchConversation } from '../db/repo/conversations.js';
import { createMessage } from '../db/repo/messages.js';
import {
	publishServerEvent,
	subscribeAllServerEvents,
	subscribeServerEvents
} from '../events/bus.js';
import { createLogger } from '../logger.js';
import { hasActiveStream } from './streams.js';

const log = createLogger('coding-proposals');

type Part = UIMessage['parts'][number];

/** What the model learns about the task a proposal became (or that it hasn't started). */
function startedTask(row: (CodingConversationRow & { title: string }) | undefined) {
	if (!row) {
		return {
			startedTask: null,
			note: "Not started: the user hasn't started this proposed task (yet)."
		};
	}
	return {
		startedTask: {
			conversationId: row.conversation_id,
			title: row.title,
			project: row.project_title,
			status: row.status,
			branch: row.branch,
			prUrl: row.pr_url
		},
		note: 'The user started this task. read_chat with startedTask.conversationId shows what the coding agent did.'
	};
}

/** The tool result with the task's current state merged into its JSON. */
function withStartedTask(output: unknown, extra: ReturnType<typeof startedTask>): unknown {
	const content = (output as { content?: { type?: string; text?: unknown }[] } | null)?.content;
	const raw = Array.isArray(content) ? content[0]?.text : undefined;
	if (typeof raw !== 'string') return output;
	let body: Record<string, unknown>;
	try {
		body = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return output;
	}
	return {
		...(output as object),
		content: [{ type: 'text', text: JSON.stringify({ ...body, ...extra }) }]
	};
}

/**
 * The prompt's history with each proposal's result showing the task it became
 * (live status, branch, PR), and coding task notices as text the model reads.
 */
export function withCodingTaskProposals(
	db: Db,
	conversationId: string,
	history: UIMessage[]
): UIMessage[] {
	const relevant = (p: Part) => isCodingTaskProposalPart(p) || p.type === CODING_TASK_NOTICE_PART;
	if (!history.some((m) => m.parts.some(relevant))) return history;
	const started = new Map(
		listProposedCodingTasks(db, conversationId).map((r) => [r.proposed_tool_call_id, r])
	);
	return history.map((message) => {
		if (!message.parts.some(relevant)) return message;
		const parts = message.parts.map((part): Part => {
			const notice = readCodingTaskNotice(part);
			if (notice) return { type: 'text', text: `[Notice] ${codingTaskNoticeText(notice)}` };
			if (!isCodingTaskProposalPart(part)) return part;
			const tool = part as Part & { state?: string; toolCallId?: string; output?: unknown };
			if (tool.state !== 'output-available' || tool.output == null) return part;
			const extra = startedTask(started.get(tool.toolCallId ?? ''));
			return { ...tool, output: withStartedTask(tool.output, extra) } as Part;
		});
		return { ...message, parts };
	});
}

/** Posts the notice unless an earlier finish already did (the claim is part of the write). */
function postNotice(userId: string, chatId: string, notice: CodingTaskNotice, db: Db): void {
	const posted = db.transaction(() => {
		if (!claimProposalReport(db, notice.conversationId)) return false;
		createMessage(db, {
			conversationId: chatId,
			role: 'assistant',
			parts: [{ type: CODING_TASK_NOTICE_PART, data: notice }],
			status: 'complete'
		});
		touchConversation(db, chatId);
		return true;
	})();
	if (!posted) return;
	log.info('Posted coding task notice', { conversationId: chatId, task: notice.conversationId });
	publishServerEvent(userId, { type: 'chat.messages.updated', conversationId: chatId });
	publishServerEvent(userId, { type: 'conversation.updated', conversationId: chatId });
}

/**
 * A notice can't join a chat while a reply streams into it (the reply's
 * message is the chat's newest), so it waits for the chat to be idle. A
 * restart in the meantime drops it; the card and the model still see the
 * task's status.
 */
function postWhenIdle(userId: string, chatId: string, notice: CodingTaskNotice, db: Db): void {
	if (!hasActiveStream(chatId)) return postNotice(userId, chatId, notice, db);
	const off = subscribeServerEvents(userId, (_userId, event) => {
		if (event.type !== 'chat.stream.finished' || event.conversationId !== chatId) return;
		// Deferred, like the message queue: a queued message may claim the chat first.
		setTimeout(() => {
			if (hasActiveStream(chatId)) return;
			off();
			try {
				postNotice(userId, chatId, notice, db);
			} catch (e) {
				log.error('Failed to post coding task notice', {
					conversationId: chatId,
					error: e instanceof Error ? e.message : String(e)
				});
			}
		}, 0);
	});
}

/** Tells the proposing chat that its task finished, the first time it does. */
export function reportFinishedProposal(
	userId: string,
	event: Extract<ServerEvent, { type: 'coding.thread.finished' }>,
	db: Db = getDb()
): void {
	const row = getCodingConversation(db, event.conversationId);
	if (!row?.proposed_in || row.proposal_reported_at !== null) return;
	// Neither chat may have been deleted meanwhile.
	const chat = getConversation(db, userId, row.proposed_in);
	const task = getConversation(db, userId, row.conversation_id);
	if (!chat || !task) return;
	postWhenIdle(
		userId,
		chat.id,
		{
			conversationId: row.conversation_id,
			title: task.title || 'Coding task',
			projectTitle: row.project_title,
			status: event.status,
			branch: event.branch ?? row.branch,
			prUrl: event.prUrl ?? row.pr_url
		},
		db
	);
}

const globalState = globalThis as { __codingProposalReporter?: () => void };

/** Starts reporting finished proposed tasks; the dev server's reloads replace the listener. */
export function startCodingProposalReporter(): void {
	globalState.__codingProposalReporter?.();
	globalState.__codingProposalReporter = subscribeAllServerEvents((userId, event) => {
		if (event.type !== 'coding.thread.finished') return;
		try {
			reportFinishedProposal(userId, event);
		} catch (e) {
			log.error('Failed to report a finished coding task', {
				conversationId: event.conversationId,
				error: e instanceof Error ? e.message : String(e)
			});
		}
	});
}
