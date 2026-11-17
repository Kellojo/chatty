import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseFrontmatter } from '../frontmatter.js';
import type { Db } from '../db/index.js';
import { memoryRoot } from './paths.js';
import { conceptIsPrivate } from './private.js';

/**
 * Keys (see rowKey) written while a reconcile reads the disk: that read may
 * be older than the write, so the reconcile leaves these rows alone.
 */
const reconcileTrackers = new Set<Set<string>>();

const rowKey = (scope: string, path: string) => `${scope}|${path}`;

export function upsertMemoryFts(
	db: Db,
	scope: string,
	path: string,
	fm: { title: string; description: string; tags: string[]; private?: boolean },
	body: string
): void {
	deleteMemoryFts(db, scope, path);
	db.prepare(
		'INSERT INTO memory_fts (scope, path, title, description, tags, body, private) VALUES (?, ?, ?, ?, ?, ?, ?)'
	).run(
		scope,
		path,
		fm.title,
		fm.description,
		fm.tags.join(' '),
		body,
		fm.private === true ? 1 : 0
	);
}

export function deleteMemoryFts(db: Db, scope: string, path: string): void {
	for (const touched of reconcileTrackers) touched.add(rowKey(scope, path));
	db.prepare('DELETE FROM memory_fts WHERE scope = ? AND path = ?').run(scope, path);
}

export interface MemorySearchHit {
	scope: string;
	path: string;
	title: string;
	description: string;
	tags: string[];
	snippet: string;
	/** A private concept; only returned with `includePrivate`. */
	private: boolean;
}

export interface MemoryReadOptions {
	/**
	 * Whether private concepts may be returned. Only the owner's own browser
	 * and trusted turns may see them; everyone else gets them filtered in SQL.
	 */
	includePrivate: boolean;
	/** Only private concepts (memory agents' private pass). Needs `includePrivate`. */
	privateOnly?: boolean;
}

/**
 * Turns free text into an FTS5 MATCH expression: any-term (OR) matching, with
 * joined words like `Pocket-ID` or `next.js` kept together as a phrase so their
 * parts don't match on their own. Only letters and digits survive, so the
 * result can never contain FTS5 syntax.
 */
function sanitizeQuery(query: string): string {
	const tokens = query.match(/[\p{L}\p{M}\p{N}]+(?:[-.'’_/][\p{L}\p{M}\p{N}]+)*/gu) ?? [];
	return tokens.map((t) => `"${t.replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')}"`).join(' OR ');
}

// bm25 weights per column (scope, path, title, description, tags, body,
// private): a hit in the title or tags says far more about a concept than one
// in its body.
const BM25_WEIGHTS = '0.0, 0.0, 10.0, 5.0, 5.0, 1.0, 0.0';

/** The WHERE condition for `options`: applied before ranking and LIMIT. */
function privacyClause(options: MemoryReadOptions): string {
	if (!options.includePrivate) return 'AND private = 0';
	return options.privateOnly ? 'AND private = 1' : '';
}

// snippet() copies concept text verbatim, so the highlight markers are control
// characters that can't appear in it, swapped for the real markup afterwards.
const MARK_OPEN = '\u0002';
const MARK_CLOSE = '\u0003';

function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function renderSnippet(raw: string, html: boolean): string {
	const text = html ? escapeHtml(raw) : raw;
	return text.split(MARK_OPEN).join('<mark>').split(MARK_CLOSE).join('</mark>');
}

/**
 * Full-text search over memory concepts. Snippets wrap matches in `<mark>`;
 * with `html`, the rest of the snippet is HTML-escaped so it's safe to render
 * as markup (concept text is often model-written and can contain anything).
 * Without `includePrivate`, private concepts are dropped before ranking and
 * LIMIT.
 */
export function searchMemoryFts(
	db: Db,
	scopes: string[],
	query: string,
	limit: number,
	options: MemoryReadOptions & { html?: boolean }
): MemorySearchHit[] {
	const match = sanitizeQuery(query);
	if (!match || scopes.length === 0) return [];
	const n = Math.min(Math.max(limit, 1), 50);
	const placeholders = scopes.map(() => '?').join(', ');
	const rows = db
		.prepare(
			`SELECT scope, path, title, description, tags, private,
				snippet(memory_fts, 5, ?, ?, '…', 24) AS snippet
			FROM memory_fts
			WHERE memory_fts MATCH ? AND scope IN (${placeholders}) ${privacyClause(options)}
			ORDER BY bm25(memory_fts, ${BM25_WEIGHTS})
			LIMIT ?`
		)
		.all(MARK_OPEN, MARK_CLOSE, match, ...scopes, n) as Array<
		Omit<MemorySearchHit, 'tags' | 'private'> & { tags: string; private: number }
	>;
	return rows.map((r) => ({
		...r,
		private: r.private === 1,
		snippet: renderSnippet(r.snippet, options.html === true),
		tags: r.tags ? r.tags.split(' ').filter((t) => t.length > 0) : []
	}));
}

/**
 * Whether any indexed concept in `scopes` is private. Deliberately ignores
 * queries and prefixes, so the "private results hidden" note it gates can't be
 * used to probe private notes' content or paths.
 */
export function hasPrivateMemory(db: Db, scopes: string[]): boolean {
	if (scopes.length === 0) return false;
	const placeholders = scopes.map(() => '?').join(', ');
	return (
		db
			.prepare(`SELECT 1 FROM memory_fts WHERE scope IN (${placeholders}) AND private = 1 LIMIT 1`)
			.get(...scopes) !== undefined
	);
}

export interface MemorySummary {
	title: string;
	description: string;
	private: boolean;
}

/**
 * Titles and descriptions of the indexed concepts in a scope, keyed by path;
 * private ones only with `includePrivate`.
 */
export function memorySummaries(
	db: Db,
	scope: string,
	options: MemoryReadOptions
): Map<string, MemorySummary> {
	const rows = db
		.prepare(
			`SELECT path, title, description, private FROM memory_fts
			WHERE scope = ? ${privacyClause(options)}`
		)
		.all(scope) as Array<Omit<MemorySummary, 'private'> & { path: string; private: number }>;
	return new Map(
		rows.map((r) => [
			r.path,
			{ title: r.title, description: r.description, private: r.private === 1 }
		])
	);
}

interface DiskEntry {
	scope: string;
	path: string;
	abs: string;
}

/** Directory entries of `dir`, or none when it doesn't exist. */
async function readDirIfExists(dir: string): Promise<Dirent[]> {
	try {
		return await fs.readdir(dir, { withFileTypes: true });
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw e;
	}
}

async function walkBundle(root: string, scope: string): Promise<DiskEntry[]> {
	const out: DiskEntry[] = [];
	const recurse = async (dir: string): Promise<void> => {
		for (const e of await readDirIfExists(dir)) {
			const abs = path.join(dir, e.name);
			if (e.isDirectory()) {
				await recurse(abs);
			} else if (e.isFile() && e.name.endsWith('.md') && e.name !== 'index.md') {
				out.push({ scope, path: path.relative(root, abs).split(path.sep).join('/'), abs });
			}
		}
	};
	await recurse(root);
	return out;
}

async function listDiskEntries(): Promise<DiskEntry[]> {
	const root = memoryRoot();
	const entries: DiskEntry[] = [];
	for (const e of await readDirIfExists(root)) {
		if (!e.isDirectory()) continue;
		const scope = e.name === 'shared' ? 'shared' : `user:${e.name}`;
		entries.push(...(await walkBundle(path.join(root, e.name), scope)));
	}
	return entries;
}

interface DiskConcept {
	entry: DiskEntry;
	fm: { title: string; description: string; tags: string[]; private: boolean };
	body: string;
}

/**
 * A concept file as the index stores it, or null when the file can't be read
 * (e.g. a transient EBUSY): its row is then kept as it is, never replaced by
 * a guess that could drop its private flag.
 */
async function readFromDisk(entry: DiskEntry): Promise<DiskConcept | null> {
	let raw: string;
	try {
		raw = await fs.readFile(entry.abs, 'utf8');
	} catch {
		return null;
	}
	let title = path.basename(entry.abs, '.md');
	let description = '';
	let tags: string[] = [];
	let isPrivate = conceptIsPrivate(null, raw);
	let body = '';
	try {
		const parsed = parseFrontmatter(raw);
		const d = parsed.data as Record<string, unknown>;
		if (typeof d.title === 'string' && d.title.trim()) title = d.title;
		if (typeof d.description === 'string') description = d.description;
		if (Array.isArray(d.tags)) tags = d.tags.filter((t): t is string => typeof t === 'string');
		isPrivate = conceptIsPrivate(d, raw);
		body = parsed.content;
	} catch {
		// invalid frontmatter: index with the filename as title; the private
		// line check above still applies, so a broken private file stays private
	}
	return { entry, fm: { title, description, tags, private: isPrivate }, body };
}

// Files read concurrently while rebuilding, to stay well clear of fd limits.
const READ_BATCH = 32;

/** Every concept file in the memory bundle (all scopes), and which ones couldn't be read. */
async function readDiskConcepts(): Promise<{ concepts: DiskConcept[]; unreadable: Set<string> }> {
	const entries = await listDiskEntries();
	const concepts: DiskConcept[] = [];
	const unreadable = new Set<string>();
	for (let i = 0; i < entries.length; i += READ_BATCH) {
		const batch = entries.slice(i, i + READ_BATCH);
		const read = await Promise.all(batch.map(readFromDisk));
		read.forEach((c, j) => {
			if (c) concepts.push(c);
			else unreadable.add(rowKey(batch[j].scope, batch[j].path));
		});
	}
	return { concepts, unreadable };
}

/**
 * Syncs the index with the files on disk: rewrites every row from its file and
 * drops rows whose file is gone. Rows written while the disk is read are newer
 * than the read, and rows of unreadable files may hold a private flag the read
 * missed: both are left as they are.
 */
export async function reconcileMemoryFts(db: Db): Promise<{ upserted: number; removed: number }> {
	const touched = new Set<string>();
	reconcileTrackers.add(touched);
	let disk: Awaited<ReturnType<typeof readDiskConcepts>>;
	try {
		disk = await readDiskConcepts();
	} finally {
		reconcileTrackers.delete(touched);
	}
	const { concepts, unreadable } = disk;
	const diskKeys = new Set(concepts.map((c) => rowKey(c.entry.scope, c.entry.path)));
	return db.transaction(() => {
		let upserted = 0;
		for (const { entry, fm, body } of concepts) {
			if (touched.has(rowKey(entry.scope, entry.path))) continue;
			upsertMemoryFts(db, entry.scope, entry.path, fm, body);
			upserted++;
		}
		const rows = db.prepare('SELECT scope, path FROM memory_fts').all() as Array<{
			scope: string;
			path: string;
		}>;
		let removed = 0;
		for (const row of rows) {
			const key = rowKey(row.scope, row.path);
			if (!diskKeys.has(key) && !touched.has(key) && !unreadable.has(key)) {
				deleteMemoryFts(db, row.scope, row.path);
				removed++;
			}
		}
		return { upserted, removed };
	})();
}

/**
 * Rebuilds the index from the files on disk (the admin "reindex" action). The
 * same sync as the startup reconcile, so it is just as safe against writes
 * made while it runs.
 */
export async function reindexMemoryFts(db: Db): Promise<{ indexed: number }> {
	const { upserted } = await reconcileMemoryFts(db);
	return { indexed: upserted };
}
