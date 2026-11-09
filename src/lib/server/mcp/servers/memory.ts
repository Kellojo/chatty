import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import {
	deleteConcept,
	listConceptPaths,
	readConcept,
	writeConcept,
	type MemoryAuditInfo
} from '../../memory/bundle.js';
import { searchMemoryFts } from '../../memory/fts.js';
import { normalizeConceptPath, type MemoryScope } from '../../memory/paths.js';
import type { CallerContext } from '../types.js';
import { err, text } from './shared.js';

const scopeSchema = z.enum(['user', 'shared']);

const SNIPPET_MAX = 160;

/** A one-line plain-text preview of a concept for the ```memory widget. */
export function memorySnippet(description: string | undefined, body: string): string {
	const source = description?.trim() || body;
	const plain = source
		.replace(/^---[\s\S]*?---/, '')
		.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target: string, label?: string) =>
			(label ?? target).replace(/\.md$/, '').split('/').pop()!
		)
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/[#>*`~]+|\b_+|_+\b/g, '')
		.replace(/^\s*[-+]\s+/gm, '')
		.replace(/\s+/g, ' ')
		.trim();
	return plain.length > SNIPPET_MAX ? `${plain.slice(0, SNIPPET_MAX - 1).trimEnd()}…` : plain;
}

/**
 * The tool result, plus the item the ```memory chat widget renders, so the
 * model can paste it into the fence verbatim.
 */
function written(
	action: 'created' | 'updated' | 'deleted',
	path: string,
	scope: MemoryScope,
	title: string | undefined,
	snippet: string
): CallToolResult {
	const item = { action, path, scope, title: title || undefined, snippet: snippet || undefined };
	return {
		content: [
			{ type: 'text', text: `${action} ${path}` },
			{ type: 'text', text: JSON.stringify(item) }
		]
	};
}

const FENCE_HINT =
	'Returns a widget item; to show the user what was remembered, end your reply with a ```memory fenced code block containing {"items":[...]} — the items from all memory writes this turn, verbatim.';
const pathSchema = z
	.string()
	.describe('Concept path, e.g. "people/john.md" (".md" is appended automatically if missing)');

export function createMemoryServer(ctx: CallerContext): McpServer {
	const server = new McpServer({ name: 'ai-chat-memory', version: '0.1.0' });

	const audit = (): MemoryAuditInfo => ({
		author: ctx.author ?? `user:${ctx.userId}`,
		userId: ctx.userId,
		conversationId: ctx.conversationId ?? null,
		agentRunId: ctx.agentRunId ?? null
	});

	const guardPath = (path: string): string | null => normalizeConceptPath(path);

	const guardSharedWrite = (scope: MemoryScope): string | null =>
		scope === 'shared' && ctx.role !== 'admin' ? 'shared bundle requires admin role' : null;

	server.registerTool(
		'search_memory',
		{
			description: "Search long-term memory (the user's and the shared bundle) by full-text query",
			inputSchema: { query: z.string(), limit: z.number().int().optional() }
		},
		async ({ query, limit }) => {
			if (!query.trim()) return err('query must not be empty');
			const hits = searchMemoryFts(getDb(), [`user:${ctx.userId}`, 'shared'], query, limit);
			return text(JSON.stringify(hits));
		}
	);

	server.registerTool(
		'read_concept',
		{
			description: 'Read a single memory concept by path',
			inputSchema: { path: pathSchema, scope: scopeSchema.optional() }
		},
		async ({ path, scope }) => {
			const normalized = guardPath(path);
			if (!normalized) return err('invalid concept path');
			const concept = readConcept(scope ?? 'user', ctx.userId, normalized);
			if (!concept) return err('concept not found');
			return text(
				JSON.stringify({
					path: concept.path,
					scope: concept.scope,
					frontmatter: concept.frontmatter,
					body: concept.body
				})
			);
		}
	);

	server.registerTool(
		'list_concepts',
		{
			description: 'List memory concept paths, optionally under a directory prefix',
			inputSchema: { prefix: z.string().optional(), scope: scopeSchema.optional() }
		},
		async ({ prefix, scope }) => {
			if (prefix) {
				const posix = prefix.split('\\').join('/');
				if (posix.split('/').some((s) => s === '..' || s === '.')) {
					return err('invalid prefix');
				}
			}
			const paths = listConceptPaths(scope ?? 'user', ctx.userId, prefix);
			return text(JSON.stringify(paths));
		}
	);

	server.registerTool(
		'create_concept',
		{
			description: `Create a new memory concept (fails if the path already exists). ${FENCE_HINT}`,
			inputSchema: {
				path: pathSchema,
				title: z.string(),
				type: z.string().optional(),
				description: z.string().optional(),
				tags: z.array(z.string()).optional(),
				body: z.string(),
				scope: scopeSchema.optional()
			}
		},
		async ({ path, title, type, description, tags, body, scope }) => {
			const normalized = guardPath(path);
			if (!normalized) return err('invalid concept path');
			const s = scope ?? 'user';
			const denied = guardSharedWrite(s);
			if (denied) return err(denied);
			if (readConcept(s, ctx.userId, normalized)) return err('concept already exists');
			try {
				writeConcept(
					getDb(),
					s,
					ctx.userId,
					normalized,
					{ frontmatter: { title, type, description, tags }, body },
					audit()
				);
			} catch (e) {
				return err(e instanceof Error ? e.message : String(e));
			}
			return written('created', normalized, s, title, memorySnippet(description, body));
		}
	);

	server.registerTool(
		'update_concept',
		{
			description: `Update an existing memory concept (omitted fields keep their current values). ${FENCE_HINT}`,
			inputSchema: {
				path: pathSchema,
				title: z.string().optional(),
				type: z.string().optional(),
				description: z.string().optional(),
				tags: z.array(z.string()).optional(),
				body: z.string().optional(),
				scope: scopeSchema.optional()
			}
		},
		async ({ path, title, type, description, tags, body, scope }) => {
			const normalized = guardPath(path);
			if (!normalized) return err('invalid concept path');
			const s = scope ?? 'user';
			const denied = guardSharedWrite(s);
			if (denied) return err(denied);
			const existing = readConcept(s, ctx.userId, normalized);
			if (!existing) return err('concept not found');
			const next = {
				frontmatter: {
					title: title ?? existing.frontmatter.title,
					type: type ?? existing.frontmatter.type,
					description: description ?? existing.frontmatter.description,
					tags: tags ?? existing.frontmatter.tags
				},
				body: body ?? existing.body
			};
			try {
				writeConcept(getDb(), s, ctx.userId, normalized, next, audit());
			} catch (e) {
				return err(e instanceof Error ? e.message : String(e));
			}
			return written(
				'updated',
				normalized,
				s,
				next.frontmatter.title,
				memorySnippet(next.frontmatter.description, next.body)
			);
		}
	);

	server.registerTool(
		'delete_concept',
		{
			description: 'Delete a memory concept. Returns a ```memory widget item (see create_concept).',
			inputSchema: { path: pathSchema, scope: scopeSchema.optional() }
		},
		async ({ path, scope }) => {
			const normalized = guardPath(path);
			if (!normalized) return err('invalid concept path');
			const s = scope ?? 'user';
			const denied = guardSharedWrite(s);
			if (denied) return err(denied);
			const existing = readConcept(s, ctx.userId, normalized);
			if (!existing) return err('concept not found');
			try {
				deleteConcept(getDb(), s, ctx.userId, normalized, audit());
			} catch (e) {
				return err(e instanceof Error ? e.message : String(e));
			}
			return written(
				'deleted',
				normalized,
				s,
				existing.frontmatter.title,
				memorySnippet(existing.frontmatter.description, existing.body)
			);
		}
	);

	return server;
}
