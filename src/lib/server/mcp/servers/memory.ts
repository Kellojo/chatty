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
import { memorySummaries, searchMemoryFts } from '../../memory/fts.js';
import { ftsScope, normalizeConceptPath, type MemoryScope } from '../../memory/paths.js';
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

/** Widget instructions, given once (create_concept); the other writes point at them. */
const FENCE_HINT =
	'Returns a widget item; to show what was remembered, end your reply with a ```memory fenced block of {"items":[...]}: the items of all memory writes this turn, verbatim.';
const SAME_ITEM = 'Returns a ```memory widget item (see create_concept).';
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
			description:
				"Search long-term memory (the user's and the shared bundle) by keyword. Any word can match and results are ranked by relevance, so use a few distinctive keywords about one topic per call (e.g. 'pocket-id oauth'), and make separate calls for unrelated topics rather than one long mixed query. Matching is by word, not meaning: if nothing relevant comes back, call list_concepts and pick by title and description instead.",
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
			description:
				'List memory concepts with their title and description, optionally under a directory prefix. Use it to find a concept by meaning when search_memory finds nothing that fits, e.g. a paraphrase or a question in another language.',
			inputSchema: { prefix: z.string().optional(), scope: scopeSchema.optional() }
		},
		async ({ prefix, scope }) => {
			if (prefix) {
				const posix = prefix.split('\\').join('/');
				if (posix.split('/').some((s) => s === '..' || s === '.')) {
					return err('invalid prefix');
				}
			}
			const bundleScope = scope ?? 'user';
			const paths = listConceptPaths(bundleScope, ctx.userId, prefix);
			const summaries = memorySummaries(getDb(), ftsScope(bundleScope, ctx.userId));
			return text(
				JSON.stringify(
					paths.map((p) => {
						const s = summaries.get(p);
						return {
							path: p,
							...(s?.title ? { title: s.title } : {}),
							...(s?.description ? { description: s.description } : {})
						};
					})
				)
			);
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
			description: `Update a memory concept; omitted fields keep their values. ${SAME_ITEM}`,
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
			description: `Delete a memory concept. ${SAME_ITEM}`,
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
