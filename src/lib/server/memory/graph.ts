import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parseFrontmatter } from '../frontmatter.js';
import { bundleDir } from './paths.js';
import type { MemoryScope } from './paths.js';
import type { MemoryGraph, MemoryGraphEdge, MemoryGraphNode } from '$lib/memory-types.js';

// Markdown links to other memories: [label](some/path.md) — anchors and URLs are skipped.
const LINK_RE = /\]\(([^)\s#]+\.md)(?:#[^)]*)?\)/g;

/** Folder name shared memories are grouped under on the map. */
export const SHARED_FOLDER = 'Shared';

async function collectConcepts(root: string): Promise<string[]> {
	const out: string[] = [];
	const walk = async (dir: string, rel: string): Promise<void> => {
		const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const e of entries) {
			const nodeRel = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) await walk(path.join(dir, e.name), nodeRel);
			else if (e.isFile() && e.name.endsWith('.md') && e.name !== 'index.md') out.push(nodeRel);
		}
	};
	await walk(root, '');
	return out.sort();
}

/** Resolves a link target the way writers use them: relative to the file, else bundle-relative. */
export function resolveLink(from: string, target: string, known: Set<string>): string | null {
	if (/^[a-z]+:/i.test(target)) return null;
	const clean = target.replace(/^\.\//, '');
	const candidates = [
		path.posix.normalize(path.posix.join(path.posix.dirname(from), clean)),
		path.posix.normalize(clean.replace(/^\/+/, ''))
	];
	return candidates.find((c) => c !== from && known.has(c)) ?? null;
}

export const graphNodeId = (scope: MemoryScope, relPath: string) => `${scope}:${relPath}`;

/**
 * Memories as a graph: one node per concept, an edge per markdown link between
 * memories of the same bundle, and a weaker edge between memories (of any of the
 * given scopes) that share a tag. Shared memories are grouped as one folder.
 */
export async function buildMemoryGraph(
	scopes: MemoryScope[],
	userId: string
): Promise<MemoryGraph> {
	const nodes: MemoryGraphNode[] = [];
	const edges: MemoryGraphEdge[] = [];
	const linkPairs = new Set<string>();
	const pairKey = (a: string, b: string) => (a < b ? `${a}\n${b}` : `${b}\n${a}`);

	for (const scope of scopes) {
		const root = bundleDir(scope, userId);
		const paths = await collectConcepts(root);
		const known = new Set(paths);
		const bodies = await Promise.all(
			paths.map((p) => readFile(path.join(root, p), 'utf8').catch(() => ''))
		);
		paths.forEach((p, i) => {
			const raw = bodies[i];
			let title = path.posix.basename(p, '.md');
			let tags: string[] = [];
			let type = '';
			let body = raw;
			try {
				const parsed = parseFrontmatter(raw);
				const d = parsed.data as Record<string, unknown>;
				if (typeof d.title === 'string' && d.title.trim()) title = d.title;
				if (typeof d.type === 'string') type = d.type;
				if (Array.isArray(d.tags)) {
					tags = d.tags
						.filter((t): t is string => typeof t === 'string')
						.map((t) => t.toLowerCase());
				}
				body = parsed.content;
			} catch {
				// keep the filename title
			}
			const dir = path.posix.dirname(p);
			const folder = scope === 'shared' ? SHARED_FOLDER : dir === '.' ? '' : dir.split('/')[0];
			const id = graphNodeId(scope, p);
			nodes.push({ id, scope, path: p, title, type, tags, folder });
			for (const m of body.matchAll(LINK_RE)) {
				let decoded: string;
				try {
					decoded = decodeURIComponent(m[1]);
				} catch {
					continue;
				}
				const target = resolveLink(p, decoded, known);
				if (!target) continue;
				const targetId = graphNodeId(scope, target);
				const key = pairKey(id, targetId);
				if (linkPairs.has(key)) continue;
				linkPairs.add(key);
				edges.push({ source: id, target: targetId, kind: 'link' });
			}
		});
	}

	// Tag edges: only for tags that are specific enough to mean something.
	const byTag = new Map<string, string[]>();
	for (const n of nodes) {
		for (const t of new Set(n.tags)) byTag.set(t, [...(byTag.get(t) ?? []), n.id]);
	}
	const tagPairs = new Set<string>();
	for (const members of byTag.values()) {
		if (members.length < 2 || members.length > 8) continue;
		for (let i = 0; i < members.length; i++) {
			for (let j = i + 1; j < members.length; j++) {
				const key = pairKey(members[i], members[j]);
				if (linkPairs.has(key) || tagPairs.has(key)) continue;
				tagPairs.add(key);
				edges.push({ source: members[i], target: members[j], kind: 'tag' });
			}
		}
	}
	return { nodes, edges };
}
