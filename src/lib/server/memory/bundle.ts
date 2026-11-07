import fs from 'node:fs';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import matter from 'gray-matter';
import { z } from 'zod';
import { parseFrontmatter } from '../frontmatter.js';
import type { Db } from '../db/index.js';
import { recordMemoryWrite } from '../db/repo/memory-writes.js';
import { publishServerEvent } from '../events/bus.js';
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

export function readConcept(scope: MemoryScope, userId: string, relPath: string): Concept | null {
	const normalized = normalizeConceptPath(relPath);
	if (!normalized) return null;
	const abs = resolveConceptAbs(scope, userId, normalized);
	if (!abs || !fs.existsSync(abs)) return null;
	let raw: string;
	try {
		raw = fs.readFileSync(abs, 'utf8');
	} catch {
		return null;
	}
	return parseConceptFile(scope, normalized, raw);
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

function regenIndex(dirAbs: string): void {
	const entries: IndexEntry[] = [];
	if (fs.existsSync(dirAbs)) {
		for (const e of fs.readdirSync(dirAbs, { withFileTypes: true })) {
			if (!e.isFile() || !e.name.endsWith('.md') || e.name === 'index.md') continue;
			let title = e.name.slice(0, -'.md'.length);
			let description = '';
			try {
				const parsed = parseFrontmatter(fs.readFileSync(path.join(dirAbs, e.name), 'utf8'));
				const d = parsed.data as Record<string, unknown>;
				if (typeof d.title === 'string' && d.title.trim()) title = d.title;
				if (typeof d.description === 'string') description = d.description;
			} catch {
				// fall back to filename title
			}
			entries.push({ file: e.name, title, description });
		}
	}
	const indexAbs = path.join(dirAbs, 'index.md');
	if (entries.length === 0) {
		if (fs.existsSync(indexAbs)) fs.unlinkSync(indexAbs);
		return;
	}
	entries.sort((a, b) => a.file.localeCompare(b.file));
	const lines = entries.map((e) => `- [${e.title}](${e.file}) — ${e.description}`);
	fs.writeFileSync(indexAbs, `# Index\n\n${lines.join('\n')}\n`);
}

function pruneEmptyDirs(startAbs: string, rootAbs: string): void {
	let dir = startAbs;
	while (dir !== rootAbs && dir.startsWith(rootAbs + path.sep)) {
		if (!fs.existsSync(dir) || fs.readdirSync(dir).length > 0) return;
		fs.rmdirSync(dir);
		dir = path.dirname(dir);
	}
}

export function writeConcept(
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
): Concept {
	const target = requireConcept(scope, userId, relPath);
	const fm = parseFrontmatterInput(input.frontmatter);
	const oldRaw = fs.existsSync(target.abs) ? fs.readFileSync(target.abs, 'utf8') : null;
	const newRaw = matter.stringify(input.body, fm);
	fs.mkdirSync(path.dirname(target.abs), { recursive: true });
	fs.writeFileSync(target.abs, newRaw);
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
		author: audit.author
	});
	regenIndex(path.dirname(target.abs));
	upsertMemoryFts(db, ftsScope(scope, userId), target.relPath, fm, input.body);
	return { scope, path: target.relPath, frontmatter: fm, body: input.body };
}

export function deleteConcept(
	db: Db,
	scope: MemoryScope,
	userId: string,
	relPath: string,
	audit: MemoryAuditInfo
): boolean {
	const target = requireConcept(scope, userId, relPath);
	if (!fs.existsSync(target.abs)) return false;
	const oldRaw = fs.readFileSync(target.abs, 'utf8');
	fs.unlinkSync(target.abs);
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
		author: audit.author
	});
	regenIndex(path.dirname(target.abs));
	pruneEmptyDirs(path.dirname(target.abs), bundleDir(scope, userId));
	deleteMemoryFts(db, ftsScope(scope, userId), target.relPath);
	return true;
}

export function moveConcept(
	db: Db,
	scope: MemoryScope,
	userId: string,
	oldPath: string,
	newPath: string,
	audit: MemoryAuditInfo
): Concept {
	const from = requireConcept(scope, userId, oldPath);
	const to = requireConcept(scope, userId, newPath);
	if (!fs.existsSync(from.abs)) throw new Error(`Concept not found: ${from.relPath}`);
	if (fs.existsSync(to.abs)) throw new Error(`Concept already exists: ${to.relPath}`);
	const raw = fs.readFileSync(from.abs, 'utf8');
	fs.mkdirSync(path.dirname(to.abs), { recursive: true });
	fs.writeFileSync(to.abs, raw);
	fs.unlinkSync(from.abs);
	regenIndex(path.dirname(from.abs));
	pruneEmptyDirs(path.dirname(from.abs), bundleDir(scope, userId));
	regenIndex(path.dirname(to.abs));
	const concept = parseConceptFile(scope, to.relPath, raw);
	const scopeTag = ftsScope(scope, userId);
	deleteMemoryFts(db, scopeTag, from.relPath);
	upsertMemoryFts(db, scopeTag, to.relPath, concept.frontmatter, concept.body);
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
		author: audit.author
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

export function listTree(scope: MemoryScope, userId: string): MemoryTreeNode[] {
	const root = bundleDir(scope, userId);
	if (!fs.existsSync(root)) return [];
	const build = (dir: string, rel: string): MemoryTreeNode[] => {
		const nodes: MemoryTreeNode[] = [];
		const entries = fs
			.readdirSync(dir, { withFileTypes: true })
			.filter(
				(e) => e.isDirectory() || (e.isFile() && e.name.endsWith('.md') && e.name !== 'index.md')
			)
			.sort((a, b) => a.name.localeCompare(b.name));
		for (const e of entries) {
			const abs = path.join(dir, e.name);
			const nodeRel = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) {
				nodes.push({ name: e.name, path: nodeRel, kind: 'dir', children: build(abs, nodeRel) });
			} else {
				let title = e.name.slice(0, -'.md'.length);
				let description = '';
				try {
					const parsed = parseFrontmatter(fs.readFileSync(abs, 'utf8'));
					const d = parsed.data as Record<string, unknown>;
					if (typeof d.title === 'string' && d.title.trim()) title = d.title;
					if (typeof d.description === 'string') description = d.description;
				} catch {
					// fall back to filename title
				}
				nodes.push({ name: e.name, path: nodeRel, kind: 'concept', title, description });
			}
		}
		return nodes;
	};
	return build(root, '');
}

export function listConceptPaths(scope: MemoryScope, userId: string, prefix?: string): string[] {
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
	if (!fs.existsSync(base)) return [];
	const out: string[] = [];
	const recurse = (dir: string, rel: string): void => {
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			const abs = path.join(dir, e.name);
			const nodeRel = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) {
				recurse(abs, nodeRel);
			} else if (e.isFile() && e.name.endsWith('.md') && e.name !== 'index.md') {
				out.push(nodeRel);
			}
		}
	};
	recurse(base, baseRel);
	return out.sort();
}
