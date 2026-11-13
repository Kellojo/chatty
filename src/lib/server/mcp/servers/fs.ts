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
import { err, HEAVY_DIRS, namesHeavyDir, text, toPosix, walkIter } from './shared.js';

const MAX_OUT = 64 * 1024;
const MAX_FILE = 1024 * 1024;
const MAX_SCAN = 5 * 1024 * 1024;
const MAX_MATCHES = 200;
const MAX_GLOB = 500;
const MAX_GLOB_SCAN = 50_000;
const MAX_GREP_FILES = 5000;
const MAX_DOWNLOAD = 100 * 1024 * 1024;
const MAX_PATTERN = 1000;
const MAX_GREP_LINE = 10_000;
const GREP_TIMEOUT_MS = 10_000;

const SCOPE = z.enum(['workspace', 'documents']);

function cap(out: string): string {
	return out.length > MAX_OUT ? `${out.slice(0, MAX_OUT)}\n… truncated` : out;
}

const CHUNK = 64 * 1024;
// Bytes of line content that always decode to more than MAX_OUT UTF-16 units
// (a UTF-8 char is at most 3 bytes per unit, `\r\n` 2 bytes per output unit),
// so reading no more than this keeps cap()'s result unchanged.
const LINES_READ_LIMIT = 4 * MAX_OUT;

type FileHandle = fsp.FileHandle;

/** Reads up to `length` bytes at `position`, fewer only at end of file. */
async function readAt(fh: FileHandle, position: number, length: number): Promise<Buffer> {
	const buf = Buffer.alloc(length);
	let total = 0;
	while (total < length) {
		const { bytesRead } = await fh.read(buf, total, length - total, position + total);
		if (bytesRead === 0) break;
		total += bytesRead;
	}
	return buf.subarray(0, total);
}

/** First `n` lines, as `content.split(/\r?\n/).slice(0, n).join('\n')` would give them. */
async function readHead(fh: FileHandle, n: number): Promise<string> {
	if (n === 0) return '';
	const chunks: Buffer[] = [];
	let bytes = 0;
	let newlines = 0;
	while (newlines < n && bytes < LINES_READ_LIMIT) {
		const chunk = await readAt(fh, bytes, CHUNK);
		if (chunk.length === 0) break;
		chunks.push(chunk);
		bytes += chunk.length;
		for (let i = chunk.indexOf(10); i !== -1; i = chunk.indexOf(10, i + 1)) newlines++;
	}
	return Buffer.concat(chunks).toString('utf-8').split(/\r?\n/).slice(0, n).join('\n');
}

/** Last `n` lines, as `content.split(/\r?\n/).slice(-n).join('\n')` would give them. */
async function readTail(fh: FileHandle, size: number, n: number): Promise<string> {
	if (n === 0) return '';
	// Scan backwards for the n-th newline from the end: the tail starts after it.
	let start = 0;
	let seen = 0;
	scan: for (let end = size; end > 0;) {
		const from = Math.max(0, end - CHUNK);
		const chunk = await readAt(fh, from, end - from);
		for (let i = chunk.lastIndexOf(10); i !== -1; i = i > 0 ? chunk.lastIndexOf(10, i - 1) : -1) {
			if (++seen === n) {
				start = from + i + 1;
				break scan;
			}
		}
		end = from;
	}
	const toEnd = size - start;
	const buf = await readAt(fh, start, Math.min(toEnd, LINES_READ_LIMIT));
	const lines = buf.toString('utf-8').split(/\r?\n/);
	// Past the read limit the output is cut by cap() anyway, which keeps its start.
	return (buf.length < toEnd ? lines : lines.slice(Math.max(0, lines.length - n))).join('\n');
}

/** `wc`-style line, word and byte counts, streamed so memory stays flat. */
async function countFile(fh: FileHandle): Promise<{ lines: number; words: number; bytes: number }> {
	// ignoreBOM keeps a leading U+FEFF in the text, like Buffer#toString.
	const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
	let lines = 0;
	let words = 0;
	let bytes = 0;
	let inWord = false;
	const countText = (s: string) => {
		if (s.length === 0) return;
		words += s.match(/\S+/g)?.length ?? 0;
		if (inWord && /^\S/.test(s)) words--; // the word continues across the chunk boundary
		inWord = /\S$/.test(s);
	};
	for (;;) {
		const chunk = await readAt(fh, bytes, CHUNK);
		if (chunk.length === 0) break;
		bytes += chunk.length;
		for (let i = chunk.indexOf(10); i !== -1; i = chunk.indexOf(10, i + 1)) lines++;
		countText(decoder.decode(chunk, { stream: true }));
	}
	countText(decoder.decode());
	return { lines, words, bytes };
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
const { pattern, flags, files, maxMatches, maxLine, maxBytes, skipBinary } = workerData;
const re = new RegExp(pattern, flags);
const out = [];
// One open per file: size limit, binary sniff (a NUL in the first 8KB) and
// the read all go through the same descriptor.
function readText(abs) {
	const fd = fs.openSync(abs, 'r');
	try {
		if (maxBytes !== undefined && fs.fstatSync(fd).size > maxBytes) return null;
		const buf = fs.readFileSync(fd);
		if (skipBinary && buf.subarray(0, 8192).includes(0)) return null;
		return buf.toString('utf-8');
	} finally {
		fs.closeSync(fd);
	}
}
for (const f of files) {
	if (out.length >= maxMatches) break;
	let content;
	try {
		content = readText(f.abs);
	} catch {
		continue;
	}
	if (content === null) continue;
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
	/** Files larger than this are skipped (default: no limit). */
	maxBytes?: number;
	/** Skip files whose first 8KB contain a NUL byte. */
	skipBinary?: boolean;
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

	// The scope roots may not exist yet (resolveInsideReal rejects a missing
	// root); create each at most once per server instance.
	const ensuredRoots = new Set<string>();

	async function resolveIn(scope: z.infer<typeof SCOPE>, rel: string): Promise<Resolved> {
		const dir = scope === 'workspace' ? ctx.workspaceDir : ctx.documentsDir;
		if (!dir) return { ok: false, error: err('no workspace available') };
		if (!ensuredRoots.has(dir)) {
			await fsp.mkdir(dir, { recursive: true });
			ensuredRoots.add(dir);
		}
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
			description:
				'Print a file. head/tail print only its first/last N lines; stats=true prints its line, word and byte counts instead.',
			inputSchema: {
				scope: SCOPE,
				path: z.string(),
				head: z.number().int().min(0).optional(),
				tail: z.number().int().min(0).optional(),
				stats: z.boolean().optional()
			}
		},
		async ({ scope, path: rel, head, tail, stats }) => {
			const r = await resolveIn(scope, rel);
			if (!r.ok) return r.error;
			let fh: FileHandle;
			try {
				fh = await fsp.open(r.abs, 'r');
			} catch {
				return err(`not a file: ${rel}`);
			}
			// Only the bytes the answer needs are read, so a huge file can't exhaust memory.
			try {
				const st = await fh.stat();
				if (!st.isFile()) return err(`not a file: ${rel}`);
				if (stats) {
					const c = await countFile(fh);
					return text(`${c.lines} ${c.words} ${c.bytes} ${toPosix(rel)}`);
				}
				if (head !== undefined) return text(cap(await readHead(fh, head)));
				if (tail !== undefined) return text(cap(await readTail(fh, st.size, tail)));
				const buf = await readAt(fh, 0, Math.min(st.size, MAX_FILE) + 1);
				if (buf.length > MAX_FILE) {
					return text(`${buf.subarray(0, MAX_FILE).toString('utf-8')}\n… truncated`);
				}
				return text(cap(buf.toString('utf-8')));
			} catch {
				return err(`not a file: ${rel}`);
			} finally {
				await fh.close();
			}
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
			let fileLimitHit = false;
			if (stat.isFile()) {
				if (stat.size > MAX_SCAN) {
					return err(`file too large to search: ${rel} (max ${MAX_SCAN / 1024 / 1024} MB)`);
				}
				targets.push({ abs: r.abs, rel: toPosix(path.relative(r.base, r.abs)) });
			} else {
				// Size and binary checks happen in the worker, on its single read of each file.
				const skipDirs = namesHeavyDir(path.relative(r.base, r.abs)) ? undefined : HEAVY_DIRS;
				for await (const e of walkIter(r.abs, { skipDirs, relTo: r.base })) {
					if (e.isDir) continue;
					if (targets.length >= MAX_GREP_FILES) {
						fileLimitHit = true;
						break;
					}
					targets.push({ abs: e.abs, rel: e.rel });
				}
			}
			const result = await grepInWorker({
				pattern,
				flags,
				files: targets,
				maxMatches: MAX_MATCHES,
				maxLine: MAX_GREP_LINE,
				maxBytes: MAX_SCAN,
				skipBinary: !stat.isFile()
			});
			if (!result.ok) return err(result.error);
			const out = cap(result.lines.join('\n'));
			// Only worth mentioning when the search could have gone on finding more.
			if (fileLimitHit && result.lines.length < MAX_MATCHES) {
				return text(
					`${out}${out ? '\n' : ''}… searched only the first ${MAX_GREP_FILES} files; narrow the path to search the rest`
				);
			}
			return text(out);
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
			// Only the subtree under the pattern's literal directory prefix can match.
			const segments = normalized === '.' ? [] : normalized.split('/');
			const firstWild = segments.findIndex((s) => /[*?]/.test(s));
			const prefix = segments.slice(0, firstWild === -1 ? segments.length - 1 : firstWild);
			let start = r.base;
			for (const seg of prefix) {
				start = path.join(start, seg);
				// lstat: like the walk, don't follow symlinked directories.
				const st = await fsp.lstat(start).catch(() => null);
				if (!st?.isDirectory()) return text('[]');
			}
			const skipDirs = namesHeavyDir(normalized) ? undefined : HEAVY_DIRS;
			const matches: string[] = [];
			let visited = 0;
			let scanLimitHit = false;
			for await (const e of walkIter(start, { skipDirs, relTo: r.base })) {
				if (matchGlob(e.rel)) matches.push(e.rel);
				if (matches.length >= MAX_GLOB) break;
				if (++visited >= MAX_GLOB_SCAN) {
					scanLimitHit = true;
					break;
				}
			}
			matches.sort();
			const out = JSON.stringify(matches);
			return text(
				scanLimitHit
					? `${out}\n… stopped after ${MAX_GLOB_SCAN} paths; use a more specific pattern`
					: out
			);
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
				'Replace text in a file. `old` must match exactly once unless replaceAll is set, which replaces every occurrence.',
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
			const matches = content.split(find).length - 1;
			if (matches === 0) return err(`text not found in ${rel}`);
			if (matches > 1 && !replaceAll) {
				return err(
					`text matches ${matches} times in ${rel}; add surrounding context to make it unique, or set replaceAll`
				);
			}
			// A replacer function, so `$&`, `$$` etc. in the new text stay literal.
			const updated = replaceAll
				? content.split(find).join(replacement)
				: content.replace(find, () => replacement);
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
			if (path.relative(r.base, r.abs) === '') return err(`refusing to delete the ${scope} root`);
			try {
				await fsp.lstat(r.abs);
			} catch {
				return err(`not found: ${rel}`);
			}
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
