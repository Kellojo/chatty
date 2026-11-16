import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { recordMemoryViews, type MemoryViewInput } from '../../db/repo/memory-views.js';
import { getStrictMemoryPrivacy } from '../../db/repo/user-settings.js';
import { createLogger } from '../../logger.js';
import {
	deleteConcept,
	listConceptPaths,
	readConcept,
	writeConcept,
	type Concept,
	type ConceptWriteGuard,
	type MemoryAuditInfo
} from '../../memory/bundle.js';
import {
	countPrivateMemoryHits,
	memorySummaries,
	searchMemoryFts,
	type MemoryReadOptions
} from '../../memory/fts.js';
import { ftsScope, normalizeConceptPath, type MemoryScope } from '../../memory/paths.js';
import { classifySensitive, reviewUpdate, type PrivacyUpdate } from '../../privacy/classify.js';
import { recordPrivacyCheck } from '../../privacy/sweep.js';
import { callerPrivacy, isPrivateContext } from '../../privacy/policy.js';
import type { CallerContext } from '../types.js';
import { hiddenNote, reportPrivate, seesPrivate } from './private-items.js';
import { err, text } from './shared.js';

const log = createLogger('memory');

const scopeSchema = z
	.enum(['user', 'shared'])
	.describe("user (default): this user's memory; shared: the bundle all users see");

const SNIPPET_MAX = 160;

/**
 * Which concepts a caller's memory tools can see. Private concepts only reach
 * trusted turns; for everyone else they don't exist, for reads and writes alike.
 * - all: a trusted turn;
 * - public: an untrusted one (the gateway too), told how many were hidden;
 * - private: memory agents' private pass, which only sees private concepts;
 * - none: an untrusted turn under strict memory privacy, which sees nothing.
 */
export type MemoryView = 'all' | 'public' | 'private' | 'none';

/** The caller's view (trust as decided by seesPrivate, plus strict mode and the pass). */
export function memoryView(ctx: CallerContext): MemoryView {
	const trusted = seesPrivate(ctx);
	// Set by memory agents' private pass (agents/builtin.ts, memoryPassLimits).
	const privateOnly = ctx.privateOnly === true;
	if (trusted) return privateOnly ? 'private' : 'all';
	if (privateOnly || getStrictMemoryPrivacy(getDb(), ctx.userId)) return 'none';
	return 'public';
}

const isPrivate = (c: Concept) => c.frontmatter.private === true;

function canSee(view: MemoryView, concept: Concept): boolean {
	if (view === 'all') return true;
	if (view === 'public') return !isPrivate(concept);
	if (view === 'private') return isPrivate(concept);
	return false;
}

function readOptions(view: MemoryView): MemoryReadOptions {
	return { includePrivate: view === 'all' || view === 'private', privateOnly: view === 'private' };
}

/** Results, plus the hidden-count note when private ones were left out. */
function withHidden(json: string, hidden: number): CallToolResult {
	if (hidden === 0) return text(json);
	return {
		content: [
			{ type: 'text', text: json },
			{ type: 'text', text: hiddenNote(hidden) }
		]
	};
}

// What a caller that may not see a concept gets: the same as for a missing one
// (reads, updates, deletes) or an invalid path (creates), so probes learn nothing.
const NOT_FOUND = 'concept not found';
const INVALID_PATH = 'invalid concept path';

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
	snippet: string,
	isPrivate = false,
	/** Set when the note was marked private automatically: why. */
	privateReason?: string
): CallToolResult {
	const item = { action, path, scope, title: title || undefined, snippet: snippet || undefined };
	const flag = privateReason ? ` (${privateReason.toLowerCase()})` : isPrivate ? ' (private)' : '';
	return {
		content: [
			{ type: 'text', text: `${action} ${path}${flag}` },
			{ type: 'text', text: JSON.stringify(item) }
		]
	};
}

/** Widget instructions, given once (create_concept); the other writes point at them. */
const FENCE_HINT =
	'To show what was remembered, end your reply with a ```memory block of {"items":[…]}: the returned items of all memory writes this turn, verbatim.';
const SAME_ITEM = 'Returns a ```memory item (see create_concept).';
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

	/** Counts concepts the model came across; tracking never fails the tool call. */
	const trackViews = (kind: MemoryViewInput['kind'], concepts: MemoryViewInput['concepts']) => {
		try {
			recordMemoryViews(getDb(), {
				kind,
				concepts,
				userId: ctx.userId,
				agent: !!ctx.agentRunId
			});
		} catch (e) {
			log.warn(`Recording memory ${kind} views failed:`, {
				error: e instanceof Error ? e.message : String(e)
			});
		}
	};

	const guardSharedWrite = (scope: MemoryScope): string | null =>
		scope === 'shared' && ctx.role !== 'admin' ? 'shared bundle requires admin role' : null;

	/**
	 * Called before a result carrying private data goes back: the turn becomes
	 * tainted (its chat private) first. Only trusted views ever get here.
	 */
	const taint = (reason: string) => reportPrivate(ctx, reason);

	/** Whether this context holds private data: everything it writes is private. */
	const writesPrivate = (view: MemoryView) =>
		view === 'private' || isPrivateContext(getDb(), callerPrivacy(ctx));

	/**
	 * The privacy of a note about to be written: private when the context is
	 * (forced), otherwise whatever the automatic check finds (see reviewUpdate):
	 * it marks notes with personal details private and flags automatically
	 * marked ones that no longer have any, but never makes a note public.
	 */
	const privacyFor = async (
		view: MemoryView,
		current: Concept | null,
		fields: { title: string; description?: string; tags?: string[]; body: string }
	): Promise<{ update: PrivacyUpdate; checked: boolean }> => {
		if (writesPrivate(view)) return { update: { private: true }, checked: false };
		const fm = current?.frontmatter ?? null;
		// Made private by a person or a private chat: not second-guessed.
		if (fm?.private && !fm.privateReason) return { update: {}, checked: false };
		const text = [
			fields.title,
			fields.description ?? '',
			(fields.tags ?? []).join(', '),
			fields.body
		].join('\n');
		const labels = await classifySensitive(getDb(), text);
		if (labels === null) return { update: {}, checked: false };
		return { update: reviewUpdate(fm, labels) ?? {}, checked: true };
	};

	server.registerTool(
		'search_memory',
		{
			description:
				"Keyword search of long-term memory (the user's and shared), ranked by relevance. Matches words, not meaning: use a few distinctive keywords on one topic (e.g. 'pocket-id oauth') and a separate call per topic. If nothing fits, browse list_concepts instead.",
			inputSchema: { query: z.string(), limit: z.number().int().optional() }
		},
		async ({ query, limit }) => {
			if (!query.trim()) return err('query must not be empty');
			const view = memoryView(ctx);
			if (view === 'none') return text('[]');
			const db = getDb();
			const scopes = [`user:${ctx.userId}`, 'shared'];
			const hits = searchMemoryFts(db, scopes, query, limit ?? 10, readOptions(view));
			trackViews(
				'search',
				hits.map((h) => ({ scope: h.scope === 'shared' ? 'shared' : 'user', path: h.path }))
			);
			if (hits.some((h) => h.private)) taint('a private note');
			const hidden = view === 'public' ? countPrivateMemoryHits(db, scopes, query) : 0;
			const out = hits.map(({ private: p, ...h }) => (p ? { ...h, private: true } : h));
			return withHidden(JSON.stringify(out), hidden);
		}
	);

	server.registerTool(
		'read_concept',
		{
			description: 'Read a memory concept by path.',
			inputSchema: { path: pathSchema, scope: scopeSchema.optional() }
		},
		async ({ path, scope }) => {
			const normalized = guardPath(path);
			if (!normalized) return err(INVALID_PATH);
			const concept = await readConcept(scope ?? 'user', ctx.userId, normalized);
			if (!concept || !canSee(memoryView(ctx), concept)) return err(NOT_FOUND);
			trackViews('read', [{ scope: concept.scope, path: concept.path }]);
			if (isPrivate(concept)) taint('a private note');
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
				'List memory concepts (title, description), optionally under a path prefix. Use it to find a concept by meaning when search_memory misses, e.g. paraphrases or another language.',
			inputSchema: { prefix: z.string().optional(), scope: scopeSchema.optional() }
		},
		async ({ prefix, scope }) => {
			if (prefix) {
				const posix = prefix.split('\\').join('/');
				if (posix.split('/').some((s) => s === '..' || s === '.')) {
					return err('invalid prefix');
				}
			}
			const view = memoryView(ctx);
			if (view === 'none') return text('[]');
			const bundleScope = scope ?? 'user';
			const paths = await listConceptPaths(bundleScope, ctx.userId, prefix);
			const summaries = memorySummaries(
				getDb(),
				ftsScope(bundleScope, ctx.userId),
				readOptions(view)
			);
			// A filtered view lists only concepts the index knows to be visible, so
			// one it hasn't indexed yet is left out rather than shown unchecked.
			const listed = view === 'all' ? paths : paths.filter((p) => summaries.has(p));
			if (listed.some((p) => summaries.get(p)?.private)) taint('a private note');
			return withHidden(
				JSON.stringify(
					listed.map((p) => {
						const s = summaries.get(p);
						return {
							path: p,
							...(s?.title ? { title: s.title } : {}),
							...(s?.description ? { description: s.description } : {}),
							...(s?.private ? { private: true } : {})
						};
					})
				),
				view === 'public' ? paths.length - listed.length : 0
			);
		}
	);

	server.registerTool(
		'create_concept',
		{
			description: `Create a memory concept; fails if the path exists. ${FENCE_HINT}`,
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
			if (!normalized) return err(INVALID_PATH);
			const s = scope ?? 'user';
			const denied = guardSharedWrite(s);
			if (denied) return err(denied);
			const view = memoryView(ctx);
			// An existing concept the caller may not see answers like an invalid
			// path, and is never overwritten.
			const guard: ConceptWriteGuard = (current) =>
				current ? (canSee(view, current) ? 'concept already exists' : INVALID_PATH) : null;
			const refused = guard(await readConcept(s, ctx.userId, normalized));
			if (refused) return err(refused);
			const { update: privacy, checked } = await privacyFor(view, null, {
				title,
				description,
				tags,
				body
			});
			try {
				const saved = await writeConcept(
					getDb(),
					s,
					ctx.userId,
					normalized,
					{
						frontmatter: { title, type, description, tags, ...privacy },
						body
					},
					audit(),
					guard
				);
				// Checked just now: the cleanup sweep needn't check it again.
				if (checked) recordPrivacyCheck(getDb(), saved, ctx.userId);
			} catch (e) {
				return err(e instanceof Error ? e.message : String(e));
			}
			return written(
				'created',
				normalized,
				s,
				title,
				memorySnippet(description, body),
				privacy.private === true,
				privacy.privateReason
			);
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
			if (!normalized) return err(INVALID_PATH);
			const s = scope ?? 'user';
			const denied = guardSharedWrite(s);
			if (denied) return err(denied);
			const view = memoryView(ctx);
			const guard: ConceptWriteGuard = (current) =>
				current && canSee(view, current) ? null : NOT_FOUND;
			const existing = await readConcept(s, ctx.userId, normalized);
			if (!existing || guard(existing)) return err(NOT_FOUND);
			// Never clears the flag: a turn can't make a private concept public.
			const fields = {
				title: title ?? existing.frontmatter.title,
				type: type ?? existing.frontmatter.type,
				description: description ?? existing.frontmatter.description,
				tags: tags ?? existing.frontmatter.tags
			};
			const nextBody = body ?? existing.body;
			const { update: privacy, checked } = await privacyFor(view, existing, {
				...fields,
				body: nextBody
			});
			const next = { frontmatter: { ...fields, ...privacy }, body: nextBody };
			let saved: Concept;
			try {
				saved = await writeConcept(getDb(), s, ctx.userId, normalized, next, audit(), guard);
				if (checked) recordPrivacyCheck(getDb(), saved, ctx.userId);
			} catch (e) {
				return err(e instanceof Error ? e.message : String(e));
			}
			if (isPrivate(existing)) taint('a private note');
			return written(
				'updated',
				normalized,
				s,
				next.frontmatter.title,
				memorySnippet(next.frontmatter.description, next.body),
				isPrivate(saved),
				privacy.privateReason ??
					(privacy.privateReview
						? 'Private, flagged for review: no personal details found'
						: undefined)
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
			if (!normalized) return err(INVALID_PATH);
			const s = scope ?? 'user';
			const denied = guardSharedWrite(s);
			if (denied) return err(denied);
			const view = memoryView(ctx);
			const guard: ConceptWriteGuard = (current) =>
				current && canSee(view, current) ? null : NOT_FOUND;
			const existing = await readConcept(s, ctx.userId, normalized);
			if (!existing || guard(existing)) return err(NOT_FOUND);
			try {
				await deleteConcept(getDb(), s, ctx.userId, normalized, audit(), guard);
			} catch (e) {
				return err(e instanceof Error ? e.message : String(e));
			}
			if (isPrivate(existing)) taint('a private note');
			return written(
				'deleted',
				normalized,
				s,
				existing.frontmatter.title,
				memorySnippet(existing.frontmatter.description, existing.body),
				isPrivate(existing)
			);
		}
	);

	return server;
}
