import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import {
	getConversation,
	listConversationsSince,
	searchConversations
} from '../../db/repo/conversations.js';
import { listMessages } from '../../db/repo/messages.js';
import type { CallerContext } from '../types.js';
import { err, text } from './shared.js';

export function createChatSearchServer(ctx: CallerContext): McpServer {
	const server = new McpServer({ name: 'ai-chat-chat-search', version: '0.1.0' });
	server.registerTool(
		'search_chats',
		{
			description:
				"Search the current user's chat conversations by title and message content, and/or list chats updated since a timestamp. Coding threads (T3 sessions) include a `coding` field with their project and status.",
			inputSchema: {
				query: z.string().optional(),
				since: z
					.string()
					.optional()
					.describe('Only chats updated at/after this time (ISO 8601 or epoch ms)'),
				limit: z.number().int().optional()
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
			const rows = q
				? searchConversations(db, ctx.userId, q)
				: listConversationsSince(db, ctx.userId, sinceMs!);
			const filtered = sinceMs !== null ? rows.filter((r) => r.updated_at >= sinceMs) : rows;
			return text(
				JSON.stringify(
					filtered.slice(0, n).map((r) => ({
						id: r.id,
						title: r.title,
						updatedAt: r.updated_at,
						...(r.coding_status
							? { coding: { project: r.coding_project_title ?? '', status: r.coding_status } }
							: {})
					}))
				)
			);
		}
	);
	server.registerTool(
		'read_chat',
		{
			description: "Read the messages of one of the current user's conversations",
			inputSchema: { conversationId: z.string(), limit: z.number().int().optional() }
		},
		async ({ conversationId, limit }) => {
			const db = getDb();
			const conversation = getConversation(db, ctx.userId, conversationId);
			if (!conversation) return err('conversation not found');
			const n = Math.min(500, Math.max(1, Math.floor(limit ?? 100)));
			const messages = listMessages(db, conversationId).slice(-n);
			return text(
				JSON.stringify(
					messages.map((m) => ({
						role: m.role,
						text: m.content_text,
						createdAt: m.created_at,
						status: m.status
					}))
				)
			);
		}
	);
	return server;
}
