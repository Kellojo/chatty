import fsp from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { sanitizeFilename } from '../../workspaces.js';
import type { CallerContext } from '../types.js';
import { readBodyLimited } from '../../net/readBody.js';
import { safeFetch } from '../../net/safeFetch.js';
import { resolveInsideReal } from '../../safePath.js';
import { err, looksTextualAsync, text, toPosix, walkAsync } from './shared.js';

const MAX_OUT = 64 * 1024;
const MAX_FILE = 1024 * 1024;
const MAX_SCAN = 5 * 1024 * 1024;
const MAX_MATCHES = 200;
const MAX_GLOB = 500;
const MAX_DOWNLOAD = 100 * 1024 * 1024;
const MAX_PATTERN = 1000;
const MAX_GREP_LINE = 10_000;
const GREP_TIMEOUT_MS = 10_000;

const SCOPE = z.enum(['workspace', 'documents']);

function cap(out: string): string {
	return out.length > MAX_OUT ? `${out.slice(0, MAX_OUT)}\n… truncated` : out;
}

type GlobNode =
	| { t: 'lit'; c: string }
	| { t: 'one' } // ?   -> [^/]
	| { t: 'seg' } // *   -> [^/]*
	| { t: 'any' } // **  -> .*
	| { t: 'dirsA' } // **/ -> (?:.*/)? — entry: skip the group or start consuming it
	| { t: 'dirsB' }; //       inside the group's `.*`, left via a '/'

function compileGlob(glob: string): GlobNode[] {
	const g = glob.replace(/\\/g, '/');
	const nodes: GlobNode[] = [];
	for (let i = 0; i < g.length; i++) {
		const c = g[i];
		if (c === '*') {
			let n = 1;
			while (g[i + 1] === '*') {
				i++;
				n++;
			}
			if (n === 1) {
				nodes.push({ t: 'seg' });
			} else if (g[i + 1] === '/') {
				i++;
				nodes.push({ t: 'dirsA' }, { t: 'dirsB' });
			} else {
				nodes.push({ t: 'any' });
			}
		} else if (c === '?') {
			nodes.push({ t: 'one' });
		} else {
			nodes.push({ t: 'lit', c });
		}
	}
	return nodes;
}

/**
 * Glob matching by NFA simulation instead of a backtracking RegExp: patterns
 * come from the model, and e.g. `*a*a*a*a*b` compiled to a regex backtracks
 * polynomially on long paths. This is O(pattern × path) and keeps the
 * semantics of the previous regex translation (see GlobNode; everything other
 * than `*` and `?` is literal).
 */
export function globMatcher(glob: string): (p: string) => boolean {
	const nodes = compileGlob(glob);
	const accept = nodes.length;
	const closure = (states: Set<number>): Set<number> => {
		const stack = [...states];
		while (stack.length) {
			const i = stack.pop()!;
			const n = nodes[i];
			if (!n) continue;
			const eps = n.t === 'seg' || n.t === 'any' ? [i + 1] : n.t === 'dirsA' ? [i + 1, i + 2] : [];
			for (const j of eps) {
				if (!states.has(j)) {
					states.add(j);
					stack.push(j);
				}
			}
		}
		return states;
	};
	return (p) => {
		let cur = closure(new Set([0]));
		for (const ch of p) {
			const next = new Set<number>();
			for (const i of cur) {
				const n = nodes[i];
				if (!n) continue;
				switch (n.t) {
					case 'lit':
						if (ch === n.c) next.add(i + 1);
						break;
					case 'one':
						if (ch !== '/') next.add(i + 1);
						break;
					case 'seg':
						if (ch !== '/') next.add(i);
						break;
					case 'any':
						next.add(i);
						break;
					case 'dirsB':
						next.add(i);
						if (ch === '/') next.add(i + 1);
						break;
				}
			}
			if (next.size === 0) return false;
			cur = closure(next);
		}
		return cur.has(accept);
	};
}

// Runs as a CommonJS script in a worker (`eval: true`) so it survives any
// bundling of this module (vite/adapter-node, vitest) without a separate entry.
const GREP_WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const { pattern, flags, files, maxMatches, maxLine } = workerData;
const re = new RegExp(pattern, flags);
const out = [];
for (const f of files) {
	if (out.length >= maxMatches) break;
	let content;
	try {
		content = fs.readFileSync(f.abs, 'utf-8');
	} catch {
		continue;
	}
	const lines = content.split(/\\r?\\n/);
	for (let i = 0; i < lines.length && out.length < maxMatches; i++) {
		const line = lines[i].length > maxLine ? lines[i].slice(0, maxLine) : lines[i];
		if (re.test(line)) out.push(f.rel + ':' + (i + 1) + ':' + line);
	}
}
parentPort.postMessage(out);
`;

export interface GrepJob {
	pattern: string;
	flags: string;
	files: Array<{ abs: string; rel: string }>;
	maxMatches: number;
	maxLine: number;
}

export type GrepResult = { ok: true; lines: string[] } | { ok: false; error: string };

/**
 * Run the regex search in a worker thread with a hard deadline. A model-supplied
 * pattern like `(a+)+$` can backtrack for hours on a single line, and nothing on
 * the main event loop can interrupt one `RegExp#test` call — terminating a
 * worker can.
 */
export function grepInWorker(job: GrepJob, timeoutMs = GREP_TIMEOUT_MS): Promise<GrepResult> {
	return new Promise((resolve) => {
		let settled = false;
		const worker = new Worker(GREP_WORKER_SOURCE, {
			eval: true,
			workerData: job,
			resourceLimits: { maxOldGenerationSizeMb: 256 }
		});
		const finish = (r: GrepResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			void worker.terminate();
			resolve(r);
		};
		const timer = setTimeout(
			() => finish({ ok: false, error: `pattern timed out after ${timeoutMs / 1000}s` }),
			timeoutMs
		);
		worker.once('message', (lines: string[]) => finish({ ok: true, lines }));
		worker.once('error', (e) => finish({ ok: false, error: `grep failed: ${e.message}` }));
		worker.once('exit', (code) =>
			finish({ ok: false, error: `grep failed: worker exited with code ${code}` })
		);
	});
}

export function createFsServer(ctx: CallerContext): McpServer {
	const server = new McpServer({ name: 'ai-chat-fs', version: '0.1.0' });

	type Resolved = { ok: true; base: string; abs: string } | { ok: false; error: CallToolResult };

	async function resolveIn(scope: z.infer<typeof SCOPE>, rel: string): Promise<Resolved> {
		const dir = scope === 'workspace' ? ctx.workspaceDir : ctx.documentsDir;
		if (!dir) return { ok: false, error: err('no workspace available') };
		await fsp.mkdir(dir, { recursive: true });
		const abs = await resolveInsideReal(dir, rel);
		if (!abs) return { ok: false, error: err(`path escapes ${scope} root`) };
		return { ok: true, base: dir, abs };
	}

	server.registerTool(
		'fs_ls',
		{
			description: 'List directory contents, directories first',
			inputSchema: { scope: SCOPE, path: z.string().optional() }
		},
		async ({ scope, path: rel }) => {
			const r = await resolveIn(scope, rel ?? '.');
			if (!r.ok) return r.error;
			let entries;
			try {
				entries = await fsp.readdir(r.abs, { withFileTypes: true });
			} catch {
				return err(`not a directory: ${rel ?? '.'}`);
			}
			const dirs = entries
				.filter((e) => e.isDirectory())
				.map((e) => `${e.name}/`)
				.sort();
			const files = entries
				.filter((e) => !e.isDirectory())
				.map((e) => e.name)
				.sort();
			return text(cap([...dirs, ...files].join('\n')));
		}
	);

	server.registerTool(
		'fs_read',
		{
			description: 'Print a file',
			inputSchema: { scope: SCOPE, path: z.string() }
		},
		async ({ scope, path: rel }) => {
			const r = await resolveIn(scope, rel);
			if (!r.ok) return r.error;
			let buf: Buffer;
			try {
				buf = await fsp.readFile(r.abs);
			} catch {
				return err(`not a file: ${rel}`);
			}
			if (buf.length > MAX_FILE) {
				return text(`${buf.subarray(0, MAX_FILE).toString('utf-8')}\n… truncated`);
			}
			return text(cap(buf.toString('utf-8')));
		}
	);

	const headTail =
		(tail: boolean) =>
		async ({
			scope,
			path: rel,
			lines
		}: {
			scope: z.infer<typeof SCOPE>;
			path: string;
			lines?: number;
		}) => {
			const r = await resolveIn(scope, rel);
			if (!r.ok) return r.error;
			let content: string;
			try {
				content = await fsp.readFile(r.abs, 'utf-8');
			} catch {
				return err(`not a file: ${rel}`);
			}
			const n = Math.max(0, Math.floor(lines ?? 40));
			const all = content.split(/\r?\n/);
			const slice = tail ? all.slice(Math.max(0, all.length - n)) : all.slice(0, n);
			return text(cap(slice.join('\n')));
		};

	server.registerTool(
		'fs_head',
		{
			description: 'Print the first lines of a file',
			inputSchema: { scope: SCOPE, path: z.string(), lines: z.number().int().optional() }
		},
		headTail(false)
	);

	server.registerTool(
		'fs_tail',
		{
			description: 'Print the last lines of a file',
			inputSchema: { scope: SCOPE, path: z.string(), lines: z.number().int().optional() }
		},
		headTail(true)
	);

	server.registerTool(
		'fs_wc',
		{
			description: 'Count lines, words and bytes of a file',
			inputSchema: { scope: SCOPE, path: z.string() }
		},
		async ({ scope, path: rel }) => {
			const r = await resolveIn(scope, rel);
			if (!r.ok) return r.error;
			let buf: Buffer;
			try {
				buf = await fsp.readFile(r.abs);
			} catch {
				return err(`not a file: ${rel}`);
			}
			const content = buf.toString('utf-8');
			const lines = content === '' ? 0 : (content.match(/\n/g)?.length ?? 0);
			const words = content.split(/\s+/).filter(Boolean).length;
			return text(`${lines} ${words} ${buf.length} ${toPosix(rel)}`);
		}
	);

	server.registerTool(
		'fs_grep',
		{
			description: 'Search files with a regular expression',
			inputSchema: {
				scope: SCOPE,
				pattern: z.string(),
				path: z.string().optional(),
				ignoreCase: z.boolean().optional()
			}
		},
		async ({ scope, pattern, path: rel, ignoreCase }) => {
			const r = await resolveIn(scope, rel ?? '.');
			if (!r.ok) return r.error;
			if (pattern.length > MAX_PATTERN) {
				return err(`pattern too long (max ${MAX_PATTERN} characters)`);
			}
			const flags = ignoreCase ? 'i' : '';
			try {
				// Validate up front so syntax errors don't cost a worker spin-up.
				new RegExp(pattern, flags);
			} catch (e) {
				return err(`invalid regex: ${e instanceof Error ? e.message : String(e)}`);
			}
			let stat;
			try {
				stat = await fsp.stat(r.abs);
			} catch {
				return err(`path not found: ${rel ?? '.'}`);
			}
			const targets: Array<{ abs: string; rel: string }> = [];
			if (stat.isFile()) {
				targets.push({ abs: r.abs, rel: toPosix(path.relative(r.base, r.abs)) });
			} else {
				for (const e of await walkAsync(r.abs)) {
					if (!e.isDir && (await looksTextualAsync(e.abs, MAX_SCAN))) {
						targets.push({ abs: e.abs, rel: toPosix(path.relative(r.base, e.abs)) });
					}
				}
			}
			const result = await grepInWorker({
				pattern,
				flags,
				files: targets,
				maxMatches: MAX_MATCHES,
				maxLine: MAX_GREP_LINE
			});
			if (!result.ok) return err(result.error);
			return text(cap(result.lines.join('\n')));
		}
	);

	server.registerTool(
		'fs_glob',
		{
			description: 'Match paths against a glob pattern (* and ** supported)',
			inputSchema: { scope: SCOPE, pattern: z.string() }
		},
		async ({ scope, pattern }) => {
			const r = await resolveIn(scope, '.');
			if (!r.ok) return r.error;
			const normalized = path.posix.normalize(pattern.replace(/\\/g, '/')).replace(/\/$/, '');
			if (/^(?:\/|[a-z]:|\.\.(?:\/|$))/i.test(normalized)) {
				return err(`pattern escapes ${scope} root`);
			}
			// Walk the root and match against it rather than using fs.glob, which
			// follows `..` and absolute patterns out of its cwd.
			if (normalized.length > MAX_PATTERN) {
				return err(`pattern too long (max ${MAX_PATTERN} characters)`);
			}
			const matchGlob = globMatcher(normalized);
			const matches: string[] = [];
			for (const e of await walkAsync(r.base)) {
				if (matchGlob(e.rel)) matches.push(e.rel);
				if (matches.length >= MAX_GLOB) break;
			}
			matches.sort();
			return text(JSON.stringify(matches));
		}
	);

	server.registerTool(
		'fs_write',
		{
			description:
				'Write a file, creating parent directories. overwrite=false fails if the file already exists.',
			inputSchema: {
				scope: SCOPE,
				path: z.string(),
				content: z.string(),
				overwrite: z.boolean().optional()
			}
		},
		async ({ scope, path: rel, content, overwrite }) => {
			const r = await resolveIn(scope, rel);
			if (!r.ok) return r.error;
			const exists = await fsp
				.stat(r.abs)
				.then(() => true)
				.catch(() => false);
			if (exists && overwrite === false) return err(`file already exists: ${rel}`);
			await fsp.mkdir(path.dirname(r.abs), { recursive: true });
			await fsp.writeFile(r.abs, content, 'utf-8');
			return text(`${exists ? 'updated' : 'created'} ${toPosix(rel)}`);
		}
	);

	server.registerTool(
		'fs_edit',
		{
			description:
				'Replace text in a file. By default replaces the first occurrence; replaceAll replaces every occurrence.',
			inputSchema: {
				scope: SCOPE,
				path: z.string(),
				old: z.string(),
				new: z.string(),
				replaceAll: z.boolean().optional()
			}
		},
		async ({ scope, path: rel, old: find, new: replacement, replaceAll }) => {
			const r = await resolveIn(scope, rel);
			if (!r.ok) return r.error;
			let content: string;
			try {
				content = await fsp.readFile(r.abs, 'utf-8');
			} catch {
				return err(`not a file: ${rel}`);
			}
			if (!content.includes(find)) return err(`text not found in ${rel}`);
			const updated = replaceAll
				? content.split(find).join(replacement)
				: content.replace(find, replacement);
			await fsp.writeFile(r.abs, updated, 'utf-8');
			return text(`edited ${toPosix(rel)}`);
		}
	);

	server.registerTool(
		'fs_mkdir',
		{
			description: 'Create a directory and any missing parents',
			inputSchema: { scope: SCOPE, path: z.string() }
		},
		async ({ scope, path: rel }) => {
			const r = await resolveIn(scope, rel);
			if (!r.ok) return r.error;
			await fsp.mkdir(r.abs, { recursive: true });
			return text(`created ${toPosix(rel)}`);
		}
	);

	server.registerTool(
		'fs_rm',
		{
			description: 'Delete a file or directory (recursive)',
			inputSchema: { scope: SCOPE, path: z.string() }
		},
		async ({ scope, path: rel }) => {
			const r = await resolveIn(scope, rel);
			if (!r.ok) return r.error;
			try {
				await fsp.rm(r.abs, { recursive: true, force: true });
			} catch (e) {
				return err(`delete failed: ${e instanceof Error ? e.message : String(e)}`);
			}
			return text(`deleted ${toPosix(rel)}`);
		}
	);

	server.registerTool(
		'fs_curl',
		{
			description: 'Download a file from a URL. Defaults to a filename derived from the URL.',
			inputSchema: {
				scope: SCOPE,
				url: z.string().url(),
				path: z.string().optional(),
				headers: z.record(z.string(), z.string()).optional()
			}
		},
		async ({ scope, url, path: rel, headers }) => {
			let parsed: URL;
			try {
				parsed = new URL(url);
			} catch {
				return err(`invalid url: ${url}`);
			}
			if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
				return err(`unsupported protocol: ${parsed.protocol}`);
			}
			const urlName = path.posix.basename(parsed.pathname);
			const target = rel ?? (urlName ? sanitizeFilename(urlName) : 'download');
			const r = await resolveIn(scope, target);
			if (!r.ok) return r.error;
			let res: Response;
			try {
				res = await safeFetch(url, {
					headers: { 'user-agent': 'ai-chat/0.1 (+https://localhost)', ...headers },
					redirect: 'follow',
					signal: AbortSignal.timeout(60000)
				});
			} catch (e) {
				return err(`download failed: ${e instanceof Error ? e.message : String(e)}`);
			}
			if (!res.ok) return err(`download failed with status ${res.status}`);
			const length = Number(res.headers.get('content-length') ?? 0);
			if (length > MAX_DOWNLOAD) return err(`file too large: ${length} bytes`);
			let buf: Buffer;
			try {
				const limited = await readBodyLimited(res, MAX_DOWNLOAD);
				if (limited.truncated) return err(`file too large: more than ${MAX_DOWNLOAD} bytes`);
				buf = limited.body;
			} catch (e) {
				return err(`download failed: ${e instanceof Error ? e.message : String(e)}`);
			}
			await fsp.mkdir(path.dirname(r.abs), { recursive: true });
			await fsp.writeFile(r.abs, buf);
			return text(`${toPosix(path.relative(r.base, r.abs))} ${buf.length} bytes`);
		}
	);

	return server;
}
