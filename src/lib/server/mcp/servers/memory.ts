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
	hasPrivateMemory,
	memorySummaries,
	searchMemoryFts,
	type MemoryReadOptions
} from '../../memory/fts.js';
import {
	conceptShapeProblem,
	conceptShapeRegressions,
	shapeRefusal,
	type ConceptShape
} from '../../memory/limits.js';
import { ftsScope, normalizeConceptPath, type MemoryScope } from '../../memory/paths.js';
import { commonWords, sharesSubject, subjectWords } from '../../memory/similar.js';
import { classifySensitive, reviewUpdate, type PrivacyUpdate } from '../../privacy/classify.js';
import { recordPrivacyCheck } from '../../privacy/sweep.js';
import { callerPrivacy, isPrivateContext } from '../../privacy/policy.js';
import type { CallerContext } from '../types.js';
import { hiddenNote, reportPrivate, seesPrivate, showsHiddenNote } from './private-items.js';
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
 * - public: an untrusted one (the gateway too); a chat turn is told that
 *   private notes are never shown (see showsHiddenNote);
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

/**
 * Results, plus the private-results note for an untrusted chat turn whose user
 * has private notes in `scopes`. The note never depends on the query or prefix.
 */
function withHidden(ctx: CallerContext, json: string, scopes: string[]): CallToolResult {
	if (!showsHiddenNote(ctx, () => hasPrivateMemory(getDb(), scopes))) return text(json);
	return {
		content: [
			{ type: 'text', text: json },
			{ type: 'text', text: hiddenNote() }
		]
	};
}

// A concept the caller may not see answers like a missing one for reads,
// updates and deletes; a create answers like for any occupied path. Either
// way, probes learn nothing about private concepts.
const NOT_FOUND = 'concept not found';
const ALREADY_EXISTS = 'concept already exists';
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

	/** Built-in memory agents (author 'system', see run-lifecycle.ts) get shape limits. */
	const shapeProblem = (fields: ConceptShape): string | null =>
		ctx.author === 'system' ? conceptShapeProblem(fields) : null;
	const shapeRegressions = (before: ConceptShape, after: ConceptShape): string | null =>
		ctx.author === 'system' ? shapeRefusal(conceptShapeRegressions(before, after)) : null;

	/**
	 * Up to three other notes that look like they're about the same subject as
	 * the note at `path` (by the words of title and tags, see memory/similar.ts),
	 * so the writer can merge instead of keeping a duplicate. Only notes the
	 * caller may see; naming a private one taints the turn like a search.
	 */
	const commonByScope = new Map<string, Set<string>>();
	const possiblyRelated = (
		view: MemoryView,
		scope: MemoryScope,
		path: string,
		note: { title: string; tags?: string[] }
	): string | null => {
		if (view === 'none') return null;
		const db = getDb();
		const fts = ftsScope(scope, ctx.userId);
		const options = readOptions(view);
		// Words most of the bundle's titles share (say, the app most notes are
		// about) don't make two notes the same subject. Worked out once per
		// server (one turn or run): a few notes created meanwhile hardly change it.
		const key = `${fts}:${view}`;
		let common = commonByScope.get(key);
		if (!common) {
			common = commonWords([...memorySummaries(db, fts, options).values()].map((s) => s.title));
			commonByScope.set(key, common);
		}
		const subject = [note.title, ...(note.tags ?? [])].join(' ');
		const words = subjectWords(subject, common);
		if (words.size === 0) return null;
		// Any-word matching: fetch enough that common words don't crowd out the match.
		const hits = searchMemoryFts(db, [fts], subject, 25, options)
			.filter(
				(h) =>
					h.path !== path &&
					sharesSubject(words, subjectWords([h.title, h.description, ...h.tags].join(' '), common))
			)
			.slice(0, 3);
		if (hits.length === 0) return null;
		if (hits.some((h) => h.private)) taint('a private note');
		const list = hits.map((h) => (h.title ? `${h.path} ("${h.title}")` : h.path)).join(', ');
		// Memory agents tidy up on their own; a chat model only saves what it was
		// asked to, so it is just told, not sent to merge and delete.
		return ctx.author === 'system'
			? `Possibly related: ${list}. Read them. Only if one is about the same subject, move this note's facts into it with update_concept and delete_concept this note; otherwise keep both.`
			: `Possibly related: ${list}. If one covers the same subject, mention it to the user instead of changing either note.`;
	};

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
			const out = hits.map(({ private: p, ...h }) => (p ? { ...h, private: true } : h));
			return withHidden(ctx, JSON.stringify(out), scopes);
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
			const fts = ftsScope(bundleScope, ctx.userId);
			const summaries = memorySummaries(getDb(), fts, readOptions(view));
			// A filtered view lists only concepts the index knows to be visible, so
			// one it hasn't indexed yet is left out rather than shown unchecked.
			const listed = view === 'all' ? paths : paths.filter((p) => summaries.has(p));
			if (listed.some((p) => summaries.get(p)?.private)) taint('a private note');
			return withHidden(
				ctx,
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
				[fts]
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
			const badShape = shapeProblem({ path: normalized, title, description, tags, body });
			if (badShape) return err(badShape);
			const view = memoryView(ctx);
			// Any occupied path answers the same, whether or not the caller may see
			// the concept there, and is never overwritten.
			const guard: ConceptWriteGuard = (current) => (current ? ALREADY_EXISTS : null);
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
			const result = written(
				'created',
				normalized,
				s,
				title,
				memorySnippet(description, body),
				privacy.private === true,
				privacy.privateReason
			);
			// Only a hint: the note is saved, so a failing search mustn't fail the call.
			try {
				const related = possiblyRelated(view, s, normalized, { title, tags });
				if (related) result.content.push({ type: 'text', text: related });
			} catch (e) {
				log.warn('Looking up related memory notes failed:', {
					error: e instanceof Error ? e.message : String(e)
				});
			}
			return result;
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
			// Only what this update makes worse is refused: a legacy note over the
			// limits can still take a small fix, and fields the call didn't pass
			// are unchanged, so never the reason.
			const badShape = shapeRegressions(
				{ ...existing.frontmatter, path: normalized, body: existing.body },
				{ ...fields, path: normalized, body: nextBody }
			);
			if (badShape) return err(badShape);
			const { update: privacy, checked } = await privacyFor(view, existing, {
				...fields,
				body: nextBody
			});
			const next = { frontmatter: { ...fields, ...privacy }, body: nextBody };
			// The privacy above was worked out for the note as read: if a person
			// changed its privacy meanwhile, their decision stands.
			const writeGuard: ConceptWriteGuard = (current) => {
				const hidden = guard(current);
				if (hidden || !current) return hidden ?? NOT_FOUND;
				const [was, now] = [existing.frontmatter, current.frontmatter];
				return Boolean(was.private) !== Boolean(now.private) ||
					was.privateReason !== now.privateReason
					? "the concept's privacy changed meanwhile; read it again"
					: null;
			};
			let saved: Concept;
			try {
				saved = await writeConcept(getDb(), s, ctx.userId, normalized, next, audit(), writeGuard);
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
