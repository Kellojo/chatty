import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from '../frontmatter.js';
import type { Db } from '../db/index.js';
import { memoryRoot } from './paths.js';

export function upsertMemoryFts(
	db: Db,
	scope: string,
	path: string,
	fm: { title: string; description: string; tags: string[] },
	body: string
): void {
	deleteMemoryFts(db, scope, path);
	db.prepare(
		'INSERT INTO memory_fts (scope, path, title, description, tags, body) VALUES (?, ?, ?, ?, ?, ?)'
	).run(scope, path, fm.title, fm.description, fm.tags.join(' '), body);
}

export function deleteMemoryFts(db: Db, scope: string, path: string): void {
	db.prepare('DELETE FROM memory_fts WHERE scope = ? AND path = ?').run(scope, path);
}

export interface MemorySearchHit {
	scope: string;
	path: string;
	title: string;
	description: string;
	tags: string[];
	snippet: string;
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

// bm25 weights per column (scope, path, title, description, tags, body): a hit
// in the title or tags says far more about a concept than one in its body.
const BM25_WEIGHTS = '0.0, 0.0, 10.0, 5.0, 5.0, 1.0';

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
 */
export function searchMemoryFts(
	db: Db,
	scopes: string[],
	query: string,
	limit = 10,
	options: { html?: boolean } = {}
): MemorySearchHit[] {
	const match = sanitizeQuery(query);
	if (!match || scopes.length === 0) return [];
	const n = Math.min(Math.max(limit, 1), 50);
	const placeholders = scopes.map(() => '?').join(', ');
	const rows = db
		.prepare(
			`SELECT scope, path, title, description, tags,
				snippet(memory_fts, 5, ?, ?, '…', 24) AS snippet
			FROM memory_fts
			WHERE memory_fts MATCH ? AND scope IN (${placeholders})
			ORDER BY bm25(memory_fts, ${BM25_WEIGHTS})
			LIMIT ?`
		)
		.all(MARK_OPEN, MARK_CLOSE, match, ...scopes, n) as Array<
		Omit<MemorySearchHit, 'tags'> & { tags: string }
	>;
	return rows.map((r) => ({
		...r,
		snippet: renderSnippet(r.snippet, options.html === true),
		tags: r.tags ? r.tags.split(' ').filter((t) => t.length > 0) : []
	}));
}

export interface MemorySummary {
	title: string;
	description: string;
}

/** Titles and descriptions of every indexed concept in a scope, keyed by path. */
export function memorySummaries(db: Db, scope: string): Map<string, MemorySummary> {
	const rows = db
		.prepare('SELECT path, title, description FROM memory_fts WHERE scope = ?')
		.all(scope) as Array<MemorySummary & { path: string }>;
	return new Map(rows.map((r) => [r.path, { title: r.title, description: r.description }]));
}

interface DiskEntry {
	scope: string;
	path: string;
	abs: string;
}

function walkBundle(root: string, scope: string): DiskEntry[] {
	const out: DiskEntry[] = [];
	const recurse = (dir: string): void => {
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			const abs = path.join(dir, e.name);
			if (e.isDirectory()) {
				recurse(abs);
			} else if (e.isFile() && e.name.endsWith('.md') && e.name !== 'index.md') {
				out.push({ scope, path: path.relative(root, abs).split(path.sep).join('/'), abs });
			}
		}
	};
	if (fs.existsSync(root)) recurse(root);
	return out;
}

function listDiskEntries(): DiskEntry[] {
	const root = memoryRoot();
	if (!fs.existsSync(root)) return [];
	const entries: DiskEntry[] = [];
	for (const e of fs.readdirSync(root, { withFileTypes: true })) {
		if (!e.isDirectory()) continue;
		const scope = e.name === 'shared' ? 'shared' : `user:${e.name}`;
		entries.push(...walkBundle(path.join(root, e.name), scope));
	}
	return entries;
}

function upsertFromDisk(db: Db, entry: DiskEntry): void {
	let title = path.basename(entry.abs, '.md');
	let description = '';
	let tags: string[] = [];
	let body = '';
	try {
		const parsed = parseFrontmatter(fs.readFileSync(entry.abs, 'utf8'));
		const d = parsed.data as Record<string, unknown>;
		if (typeof d.title === 'string' && d.title.trim()) title = d.title;
		if (typeof d.description === 'string') description = d.description;
		if (Array.isArray(d.tags)) tags = d.tags.filter((t): t is string => typeof t === 'string');
		body = parsed.content;
	} catch {
		// unreadable file or invalid frontmatter: index with filename as title
	}
	upsertMemoryFts(db, entry.scope, entry.path, { title, description, tags }, body);
}

export function reconcileMemoryFts(db: Db): { upserted: number; removed: number } {
	const disk = listDiskEntries();
	const diskKeys = new Set(disk.map((e) => `${e.scope}${e.path}`));
	let upserted = 0;
	for (const entry of disk) {
		upsertFromDisk(db, entry);
		upserted++;
	}
	const rows = db.prepare('SELECT scope, path FROM memory_fts').all() as Array<{
		scope: string;
		path: string;
	}>;
	let removed = 0;
	for (const row of rows) {
		if (!diskKeys.has(`${row.scope}${row.path}`)) {
			deleteMemoryFts(db, row.scope, row.path);
			removed++;
		}
	}
	return { upserted, removed };
}

export function reindexMemoryFts(db: Db): { indexed: number } {
	db.prepare('DELETE FROM memory_fts').run();
	const disk = listDiskEntries();
	for (const entry of disk) upsertFromDisk(db, entry);
	return { indexed: disk.length };
}
