import type { Dirent } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import matter from 'gray-matter';
import { z } from 'zod';
import { parseFrontmatter } from '../frontmatter.js';
import type { Db } from '../db/index.js';
import { moveMemoryViews } from '../db/repo/memory-views.js';
import { recordMemoryWrite } from '../db/repo/memory-writes.js';
import { publishServerEvent } from '../events/bus.js';
import { createLogger } from '../logger.js';
import { deleteMemoryFts, upsertMemoryFts } from './fts.js';
import { ftsScope, bundleDir, normalizeConceptPath, resolveConceptAbs } from './paths.js';
import type { MemoryScope } from './paths.js';

export interface ConceptFrontmatter {
	type: string;
	title: string;
	description: string;
	tags: string[];
	timestamp: string;
}

export interface Concept {
	scope: MemoryScope;
	path: string;
	frontmatter: ConceptFrontmatter;
	body: string;
}

export interface MemoryAuditInfo {
	author: string;
	userId: string;
	conversationId?: string | null;
	agentRunId?: string | null;
}

const frontmatterSchema = z.object({
	title: z.string().trim().min(1).max(200),
	type: z.string().trim().min(1).max(50).default('concept'),
	description: z.string().trim().max(500).default(''),
	tags: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
	timestamp: z.string().default(() => new Date().toISOString())
});

function parseFrontmatterInput(input: unknown): ConceptFrontmatter {
	const parsed = frontmatterSchema.safeParse(input);
	if (!parsed.success) {
		const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
		throw new Error(`Invalid concept frontmatter: ${issues}`);
	}
	return parsed.data;
}

function requireConcept(
	scope: MemoryScope,
	userId: string,
	relPath: string
): { relPath: string; abs: string } {
	const normalized = normalizeConceptPath(relPath);
	const abs = normalized ? resolveConceptAbs(scope, userId, normalized) : null;
	if (!normalized || !abs) throw new Error(`Invalid concept path: ${relPath}`);
	return { relPath: normalized, abs };
}

function parseConceptFile(scope: MemoryScope, relPath: string, raw: string): Concept {
	let data: Record<string, unknown> = {};
	let body = raw;
	try {
		const parsed = parseFrontmatter(raw);
		data = parsed.data as Record<string, unknown>;
		body = parsed.content;
	} catch {
		// invalid frontmatter: treat whole file as body
	}
	return {
		scope,
		path: relPath,
		frontmatter: {
			type: typeof data.type === 'string' && data.type.trim() ? data.type : 'concept',
			title:
				typeof data.title === 'string' && data.title.trim()
					? data.title
					: path.basename(relPath, '.md'),
			description: typeof data.description === 'string' ? data.description : '',
			tags: Array.isArray(data.tags)
				? data.tags.filter((t): t is string => typeof t === 'string')
				: [],
			timestamp: typeof data.timestamp === 'string' ? data.timestamp : ''
		},
		body
	};
}

export async function readConcept(
	scope: MemoryScope,
	userId: string,
	relPath: string
): Promise<Concept | null> {
	const normalized = normalizeConceptPath(relPath);
	if (!normalized) return null;
	const abs = resolveConceptAbs(scope, userId, normalized);
	if (!abs) return null;
	let raw: string;
	try {
		raw = await fsp.readFile(abs, 'utf8');
	} catch {
		return null;
	}
	return parseConceptFile(scope, normalized, raw);
}

/** File contents, or null when it does not exist. */
async function readIfExists(abs: string): Promise<string | null> {
	try {
		return await fsp.readFile(abs, 'utf8');
	} catch (e) {
		if (isMissing(e)) return null;
		throw e;
	}
}

// Mutations of one bundle run one at a time: each reads the old file (for the
// audit diff) before writing, and a move checks both paths, so their awaits
// must not interleave with another write to the same bundle.
const bundleLocks = new Map<string, Promise<void>>();

function withBundleLock<T>(rootAbs: string, fn: () => Promise<T>): Promise<T> {
	const run = (bundleLocks.get(rootAbs) ?? Promise.resolve()).then(fn);
	const tail = run.then(
		() => {},
		() => {}
	);
	bundleLocks.set(rootAbs, tail);
	void tail.then(() => {
		if (bundleLocks.get(rootAbs) === tail) bundleLocks.delete(rootAbs);
	});
	return run;
}

function auditTarget(
	scope: MemoryScope,
	userId: string,
	relPath: string,
	audit: MemoryAuditInfo
): { userId: string; conceptPath: string } {
	return scope === 'shared'
		? { userId: audit.userId, conceptPath: `shared/${relPath}` }
		: { userId, conceptPath: relPath };
}

interface IndexEntry {
	file: string;
	title: string;
	description: string;
}

const log = createLogger('memory');

function isMissing(e: unknown): boolean {
	return (e as NodeJS.ErrnoException).code === 'ENOENT';
}

const isConceptFile = (e: Dirent) => e.isFile() && e.name.endsWith('.md') && e.name !== 'index.md';

// Each bundle directory carries an index.md listing its concepts (part of the
// OKF bundle layout, for people and tools browsing the files; see the memory
// section of requirements.md). The app never reads it, and rebuilding it
// re-reads every sibling concept, so rebuilds run off the write path:
// debounced per directory (a consolidation run writes many concepts in a
// burst) and serialized per directory so two rebuilds never interleave.
const INDEX_DEBOUNCE_MS = 1000;
const indexTimers = new Map<string, ReturnType<typeof setTimeout>>();
const indexRuns = new Map<string, Promise<void>>();

async function regenIndex(dirAbs: string): Promise<void> {
	let dirents: Dirent[] = [];
	try {
		dirents = await fsp.readdir(dirAbs, { withFileTypes: true });
	} catch (e) {
		if (!isMissing(e)) throw e;
	}
	const entries: IndexEntry[] = [];
	for (const e of dirents) {
		if (!isConceptFile(e)) continue;
		let title = e.name.slice(0, -'.md'.length);
		let description = '';
		try {
			const parsed = parseFrontmatter(await fsp.readFile(path.join(dirAbs, e.name), 'utf8'));
			const d = parsed.data as Record<string, unknown>;
			if (typeof d.title === 'string' && d.title.trim()) title = d.title;
			if (typeof d.description === 'string') description = d.description;
		} catch {
			// fall back to filename title
		}
		entries.push({ file: e.name, title, description });
	}
	const indexAbs = path.join(dirAbs, 'index.md');
	if (entries.length === 0) {
		await fsp.rm(indexAbs, { force: true });
		return;
	}
	entries.sort((a, b) => a.file.localeCompare(b.file));
	const lines = entries.map((e) => `- [${e.title}](${e.file}) — ${e.description}`);
	await fsp.writeFile(indexAbs, `# Index\n\n${lines.join('\n')}\n`);
}

function runIndex(dirAbs: string): void {
	clearTimeout(indexTimers.get(dirAbs));
	indexTimers.delete(dirAbs);
	const run: Promise<void> = (indexRuns.get(dirAbs) ?? Promise.resolve())
		.then(() => regenIndex(dirAbs))
		.catch((e: unknown) => {
			// The directory was pruned meanwhile: nothing left to index.
			if (isMissing(e)) return;
			log.warn('Failed to rebuild memory index.md', {
				dir: dirAbs,
				error: e instanceof Error ? e.message : String(e)
			});
		})
		.finally(() => {
			if (indexRuns.get(dirAbs) === run) indexRuns.delete(dirAbs);
		});
	indexRuns.set(dirAbs, run);
}

function scheduleIndex(dirAbs: string): void {
	clearTimeout(indexTimers.get(dirAbs));
	const timer = setTimeout(() => runIndex(dirAbs), INDEX_DEBOUNCE_MS);
	timer.unref?.();
	indexTimers.set(dirAbs, timer);
}

/** Runs pending index.md rebuilds now and waits for all of them (tests, shutdown). */
export async function flushMemoryIndexes(): Promise<void> {
	for (const dir of [...indexTimers.keys()]) runIndex(dir);
	await Promise.all(indexRuns.values());
}

/**
 * After a concept left `dirAbs`: when no concepts remain, drop its index.md
 * and prune the emptied directories right away (one readdir, so the tree never
 * shows an empty folder); otherwise schedule the index rebuild.
 */
async function settleDirAfterRemoval(dirAbs: string, rootAbs: string): Promise<void> {
	let dirents: Dirent[];
	try {
		dirents = await fsp.readdir(dirAbs, { withFileTypes: true });
	} catch {
		return;
	}
	if (dirents.some(isConceptFile)) {
		scheduleIndex(dirAbs);
		return;
	}
	await fsp.rm(path.join(dirAbs, 'index.md'), { force: true });
	await pruneEmptyDirs(dirAbs, rootAbs);
	// A rebuild already in flight may write index.md again; let a later one clear it.
	if (indexRuns.has(dirAbs)) scheduleIndex(dirAbs);
}

async function pruneEmptyDirs(startAbs: string, rootAbs: string): Promise<void> {
	let dir = startAbs;
	while (dir !== rootAbs && dir.startsWith(rootAbs + path.sep)) {
		try {
			if ((await fsp.readdir(dir)).length > 0) return;
			await fsp.rmdir(dir);
		} catch {
			return; // gone already, or refilled meanwhile
		}
		dir = path.dirname(dir);
	}
}

export async function writeConcept(
	db: Db,
	scope: MemoryScope,
	userId: string,
	relPath: string,
	input: {
		frontmatter: {
			title: string;
			type?: string;
			description?: string;
			tags?: string[];
			timestamp?: string;
		};
		body: string;
	},
	audit: MemoryAuditInfo
): Promise<Concept> {
	const target = requireConcept(scope, userId, relPath);
	const fm = parseFrontmatterInput(input.frontmatter);
	const newRaw = matter.stringify(input.body, fm);
	const oldRaw = await withBundleLock(bundleDir(scope, userId), async () => {
		const old = await readIfExists(target.abs);
		await fsp.mkdir(path.dirname(target.abs), { recursive: true });
		await fsp.writeFile(target.abs, newRaw);
		return old;
	});
	const diff = createTwoFilesPatch(
		`a/${target.relPath}`,
		`b/${target.relPath}`,
		oldRaw ?? '',
		newRaw
	);
	const t = auditTarget(scope, userId, target.relPath, audit);
	const action = oldRaw === null ? 'create' : 'update';
	recordMemoryWrite(db, {
		userId: t.userId,
		conversationId: audit.conversationId,
		agentRunId: audit.agentRunId,
		conceptPath: t.conceptPath,
		action,
		author: audit.author,
		diff
	});
	publishServerEvent(scope === 'user' ? userId : audit.userId, {
		type: 'memory.changed',
		scope,
		path: target.relPath,
		action,
		author: audit.author,
		...(audit.agentRunId ? { agentRunId: audit.agentRunId } : {})
	});
	scheduleIndex(path.dirname(target.abs));
	upsertMemoryFts(db, ftsScope(scope, userId), target.relPath, fm, input.body);
	return { scope, path: target.relPath, frontmatter: fm, body: input.body };
}

export async function deleteConcept(
	db: Db,
	scope: MemoryScope,
	userId: string,
	relPath: string,
	audit: MemoryAuditInfo
): Promise<boolean> {
	const target = requireConcept(scope, userId, relPath);
	const rootAbs = bundleDir(scope, userId);
	const oldRaw = await withBundleLock(rootAbs, async () => {
		const old = await readIfExists(target.abs);
		if (old === null) return null;
		await fsp.unlink(target.abs);
		await settleDirAfterRemoval(path.dirname(target.abs), rootAbs);
		return old;
	});
	if (oldRaw === null) return false;
	const diff = createTwoFilesPatch(`a/${target.relPath}`, `b/${target.relPath}`, oldRaw, '');
	const t = auditTarget(scope, userId, target.relPath, audit);
	recordMemoryWrite(db, {
		userId: t.userId,
		conversationId: audit.conversationId,
		agentRunId: audit.agentRunId,
		conceptPath: t.conceptPath,
		action: 'delete',
		author: audit.author,
		diff
	});
	publishServerEvent(scope === 'user' ? userId : audit.userId, {
		type: 'memory.changed',
		scope,
		path: target.relPath,
		action: 'delete',
		author: audit.author,
		...(audit.agentRunId ? { agentRunId: audit.agentRunId } : {})
	});
	deleteMemoryFts(db, ftsScope(scope, userId), target.relPath);
	return true;
}

export async function moveConcept(
	db: Db,
	scope: MemoryScope,
	userId: string,
	oldPath: string,
	newPath: string,
	audit: MemoryAuditInfo
): Promise<Concept> {
	const from = requireConcept(scope, userId, oldPath);
	const to = requireConcept(scope, userId, newPath);
	const rootAbs = bundleDir(scope, userId);
	const raw = await withBundleLock(rootAbs, async () => {
		const content = await readIfExists(from.abs);
		if (content === null) throw new Error(`Concept not found: ${from.relPath}`);
		await fsp.mkdir(path.dirname(to.abs), { recursive: true });
		try {
			// 'wx' fails when the target exists, so the check and the write are one step.
			await fsp.writeFile(to.abs, content, { flag: 'wx' });
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
				throw new Error(`Concept already exists: ${to.relPath}`, { cause: e });
			}
			throw e;
		}
		await fsp.unlink(from.abs);
		await settleDirAfterRemoval(path.dirname(from.abs), rootAbs);
		return content;
	});
	scheduleIndex(path.dirname(to.abs));
	const concept = parseConceptFile(scope, to.relPath, raw);
	const scopeTag = ftsScope(scope, userId);
	deleteMemoryFts(db, scopeTag, from.relPath);
	upsertMemoryFts(db, scopeTag, to.relPath, concept.frontmatter, concept.body);
	moveMemoryViews(db, scope, userId, from.relPath, to.relPath);
	const diff = createTwoFilesPatch(`a/${from.relPath}`, `b/${to.relPath}`, raw, raw);
	const t = auditTarget(scope, userId, to.relPath, audit);
	recordMemoryWrite(db, {
		userId: t.userId,
		conversationId: audit.conversationId,
		agentRunId: audit.agentRunId,
		conceptPath: t.conceptPath,
		action: 'update',
		author: audit.author,
		diff
	});
	publishServerEvent(scope === 'user' ? userId : audit.userId, {
		type: 'memory.changed',
		scope,
		path: to.relPath,
		action: 'update',
		author: audit.author,
		...(audit.agentRunId ? { agentRunId: audit.agentRunId } : {})
	});
	return concept;
}

export interface MemoryTreeNode {
	name: string;
	path: string;
	kind: 'dir' | 'concept';
	title?: string;
	description?: string;
	children?: MemoryTreeNode[];
}

/** Directory entries, or none when the directory does not exist. */
async function readDirIfExists(dir: string): Promise<Dirent[]> {
	try {
		return await fsp.readdir(dir, { withFileTypes: true });
	} catch (e) {
		if (isMissing(e)) return [];
		throw e;
	}
}

export async function listTree(scope: MemoryScope, userId: string): Promise<MemoryTreeNode[]> {
	const build = async (dir: string, rel: string): Promise<MemoryTreeNode[]> => {
		const entries = (await readDirIfExists(dir))
			.filter((e) => e.isDirectory() || isConceptFile(e))
			.sort((a, b) => a.name.localeCompare(b.name));
		return Promise.all(
			entries.map(async (e): Promise<MemoryTreeNode> => {
				const abs = path.join(dir, e.name);
				const nodeRel = rel ? `${rel}/${e.name}` : e.name;
				if (e.isDirectory()) {
					return { name: e.name, path: nodeRel, kind: 'dir', children: await build(abs, nodeRel) };
				}
				let title = e.name.slice(0, -'.md'.length);
				let description = '';
				try {
					const parsed = parseFrontmatter(await fsp.readFile(abs, 'utf8'));
					const d = parsed.data as Record<string, unknown>;
					if (typeof d.title === 'string' && d.title.trim()) title = d.title;
					if (typeof d.description === 'string') description = d.description;
				} catch {
					// fall back to filename title
				}
				return { name: e.name, path: nodeRel, kind: 'concept', title, description };
			})
		);
	};
	return build(bundleDir(scope, userId), '');
}

/**
 * Number of concepts in a bundle, counted from the FTS index rather than by
 * walking the files: it holds one row per concept, kept in step by every
 * write/move/delete here and reconciled with the files at startup.
 */
export function countConcepts(db: Db, scope: MemoryScope, userId: string): number {
	const row = db
		.prepare('SELECT count(*) AS n FROM memory_fts WHERE scope = ?')
		.get(ftsScope(scope, userId)) as { n: number };
	return row.n;
}

export async function listConceptPaths(
	scope: MemoryScope,
	userId: string,
	prefix?: string
): Promise<string[]> {
	const root = bundleDir(scope, userId);
	let base = root;
	let baseRel = '';
	if (prefix) {
		const normalized = prefix.split('\\').join('/').replace(/\/+$/, '');
		if (
			!normalized ||
			normalized.startsWith('/') ||
			/^[a-zA-Z]:/.test(normalized) ||
			normalized.split('/').some((s) => s.length === 0 || s === '.' || s === '..')
		) {
			return [];
		}
		const abs = path.resolve(root, normalized);
		if (abs !== root && !abs.startsWith(root + path.sep)) return [];
		base = abs;
		baseRel = normalized;
	}
	const out: string[] = [];
	const recurse = async (dir: string, rel: string): Promise<void> => {
		for (const e of await readDirIfExists(dir)) {
			const abs = path.join(dir, e.name);
			const nodeRel = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) {
				await recurse(abs, nodeRel);
			} else if (isConceptFile(e)) {
				out.push(nodeRel);
			}
		}
	};
	await recurse(base, baseRel);
	return out.sort();
}
