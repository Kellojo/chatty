import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { getCodingConversation, toPublic } from '../../db/repo/coding-conversations.js';
import {
	countPrivateConversationsSince,
	countPrivateSearchMatches,
	getConversation,
	listConversationsSince,
	MAX_SEARCH_PAGE_SIZE,
	searchConversationsRanked
} from '../../db/repo/conversations.js';
import { getMessageTexts, listActivePathIds } from '../../db/repo/messages.js';
import type { CallerContext } from '../types.js';
import {
	decodeCursor,
	READ_CHAT_DEFAULT_CHARS,
	READ_CHAT_MAX_CHARS,
	READ_CHAT_MIN_CHARS,
	readChatPage
} from './chat-pages.js';
import { hiddenNote, reportPrivate, seesPrivate } from './private-items.js';
import { err, text } from './shared.js';

/** What a coding thread (T3 session) reports beyond the chat fields; unset values are left out. */
function codingSummary(conversationId: string) {
	const row = getCodingConversation(getDb(), conversationId);
	if (!row) return undefined;
	const c = toPublic(row);
	const summary = {
		project: c.projectTitle,
		status: c.status,
		provider: c.providerInstanceId,
		model: c.model,
		autonomy: c.runtimeMode,
		workspace: c.workspaceMode,
		branch: c.branch,
		baseBranch: c.baseBranch,
		pullRequest: c.prUrl,
		pullRequestState: c.prState,
		linesAdded: c.diff?.insertions ?? null,
		linesRemoved: c.diff?.deletions ?? null,
		runStartedAt: c.status === 'running' ? c.runStartedAt : null,
		waitingFor: c.pendingRequest
			? { kind: c.pendingRequest.kind, title: c.pendingRequest.title }
			: null,
		lastError: c.lastError
	};
	return Object.fromEntries(Object.entries(summary).filter(([, v]) => v !== null));
}

export function createChatSearchServer(ctx: CallerContext): McpServer {
	const server = new McpServer({ name: 'ai-chat-chat-search', version: '0.1.0' });
	server.registerTool(
		'search_chats',
		{
			description:
				"Search the user's chats by title and content (any word matches, best first: use a few distinctive keywords) and/or list chats updated since a time. Coding threads include a `coding` field (project, status, branch, PR, pending question). " +
				'For an overview, reply with a ```chats block of {"title"?, "chats":[…]}: result objects verbatim, each optionally with a one-line "summary".',
			inputSchema: {
				query: z.string().optional(),
				since: z
					.string()
					.optional()
					.describe('Only chats updated at/after this time (ISO 8601 or epoch ms)'),
				limit: z.number().int().optional().describe('Default 10, max 50')
			}
		},
		async ({ query, since, limit }) => {
			const q = query?.trim() ?? '';
			let sinceMs: number | null = null;
			if (since?.trim()) {
				const asNum = Number(since);
				const parsed = Date.parse(since);
				if (Number.isFinite(asNum)) sinceMs = asNum;
				else if (!Number.isNaN(parsed)) sinceMs = parsed;
				else return err('invalid since timestamp (use ISO 8601 or epoch ms)');
			}
			if (!q && sinceMs === null) return err('provide a query and/or since');
			const n = Math.min(50, Math.max(1, Math.floor(limit ?? 10)));
			const db = getDb();
			// The chat the tool is called from is never a useful hit.
			const current = ctx.conversationId ?? null;
			// Private chats only reach a turn that may see them (filtered in SQL,
			// before any limit); others learn how many were left out.
			const includePrivate = seesPrivate(ctx);
			const rows = q
				? searchConversationsRanked(db, ctx.userId, q, {
						// The filter below runs after the search: fetch more for since, and
						// one extra to make up for dropping the current chat.
						limit: sinceMs !== null ? MAX_SEARCH_PAGE_SIZE : current ? n + 1 : n,
						includePrivate
					})
				: // A plain "what changed since" listing is how memory extraction finds new
					// chats; agent-run chats hold the agent's words, not the user's, so they
					// are left out. A text query still finds them.
					listConversationsSince(db, ctx.userId, sinceMs!, {
						excludeDispatched: true,
						includePrivate
					});
			const shown = rows
				.filter((r) => r.id !== current && (sinceMs === null || r.updated_at >= sinceMs))
				.slice(0, n);
			if (shown.some((r) => r.private === 1)) reportPrivate(ctx, 'a private chat');
			const json = JSON.stringify(
				shown.map((r) => ({
					id: r.id,
					title: r.title,
					updatedAt: r.updated_at,
					...(r.private === 1 ? { private: true } : {}),
					...(r.coding_status ? { coding: codingSummary(r.id) } : {})
				}))
			);
			if (includePrivate) return text(json);
			const hidden = q
				? countPrivateSearchMatches(db, ctx.userId, q, { since: sinceMs })
				: countPrivateConversationsSince(db, ctx.userId, sinceMs!, { excludeDispatched: true });
			return text(
				hidden > 0
					? `${json}
${hiddenNote(hidden)}`
					: json
			);
		}
	);
	server.registerTool(
		'read_chat',
		{
			description:
				"Read a chat's messages (id from search_chats), one page of about maxChars characters at a time, oldest to newest within the page. " +
				'By default the page holds the latest messages; from "start" begins at the first. Long messages are split across pages (`cut` marks where text continues). ' +
				'To read on, call again with `olderCursor` (text before the page) or `newerCursor` (text after it) as `cursor`; stop once you have what you need.',
			inputSchema: {
				conversationId: z.string(),
				from: z
					.enum(['start', 'end'])
					.optional()
					.describe('Where the first page is taken from without a cursor. Default "end" (latest).'),
				cursor: z
					.string()
					.optional()
					.describe('olderCursor or newerCursor from a previous page of this chat'),
				maxChars: z
					.number()
					.int()
					.optional()
					.describe(
						`Page size in characters. Default ${READ_CHAT_DEFAULT_CHARS}, ${READ_CHAT_MIN_CHARS}-${READ_CHAT_MAX_CHARS}`
					)
			}
		},
		async ({ conversationId, from, cursor, maxChars }) => {
			const db = getDb();
			const conversation = getConversation(db, ctx.userId, conversationId);
			// A private chat doesn't exist for a turn that may not see it.
			const isPrivate = conversation?.private === 1;
			if (!conversation || (isPrivate && !seesPrivate(ctx))) return err('conversation not found');
			const decoded = cursor ? decodeCursor(cursor) : null;
			if (cursor && !decoded) return err('invalid cursor');
			const page = readChatPage(
				listActivePathIds(db, conversationId),
				(ids) => getMessageTexts(db, ids),
				{
					from: from ?? 'end',
					cursor: decoded,
					maxChars: Math.min(
						READ_CHAT_MAX_CHARS,
						Math.max(READ_CHAT_MIN_CHARS, Math.floor(maxChars ?? READ_CHAT_DEFAULT_CHARS))
					)
				}
			);
			if ('error' in page) return err(page.error);
			if (isPrivate) reportPrivate(ctx, 'a private chat');
			return text(JSON.stringify(page));
		}
	);
	return server;
}
