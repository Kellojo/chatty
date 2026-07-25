import fsp from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { sanitizeFilename } from '../../workspaces.js';
import type { CallerContext } from '../types.js';
import {
	err,
	looksTextualAsync,
	resolveInside,
	text,
	toPosix,
	walkAsync
} from './shared.js';

const MAX_OUT = 64 * 1024;
const MAX_FILE = 1024 * 1024;
const MAX_SCAN = 5 * 1024 * 1024;
const MAX_MATCHES = 200;
const MAX_GLOB = 500;
const MAX_DOWNLOAD = 100 * 1024 * 1024;

const SCOPE = z.enum(['workspace', 'documents']);

function cap(out: string): string {
	return out.length > MAX_OUT ? `${out.slice(0, MAX_OUT)}\n… truncated` : out;
}

function globToRegExp(glob: string): RegExp {
	const g = glob.replace(/\\/g, '/');
	let out = '';
	for (let i = 0; i < g.length; i++) {
		const c = g[i];
		if (c === '*') {
			if (g[i + 1] === '*') {
				i++;
				if (g[i + 1] === '/') {
					i++;
					out += '(?:.*/)?';
				} else {
					out += '.*';
				}
			} else {
				out += '[^/]*';
			}
		} else if (c === '?') {
			out += '[^/]';
		} else {
			out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
		}
	}
	return new RegExp(`^${out}$`);
}

export function createFsServer(ctx: CallerContext): McpServer {
	const server = new McpServer({ name: 'ai-chat-fs', version: '0.1.0' });

	type Resolved = { ok: true; base: string; abs: string } | { ok: false; error: CallToolResult };

	async function resolveIn(
		scope: z.infer<typeof SCOPE>,
		rel: string
	): Promise<Resolved> {
		const dir = scope === 'workspace' ? ctx.workspaceDir : ctx.documentsDir;
		if (!dir) return { ok: false, error: err('no workspace available') };
		await fsp.mkdir(dir, { recursive: true });
		const abs = resolveInside(dir, rel);
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
		async ({ scope, path: rel, lines }: { scope: z.infer<typeof SCOPE>; path: string; lines?: number }) => {
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
			let re: RegExp;
			try {
				re = new RegExp(pattern, ignoreCase ? 'i' : '');
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
			const out: string[] = [];
			for (const t of targets) {
				if (out.length >= MAX_MATCHES) break;
				const lines = (await fsp.readFile(t.abs, 'utf-8')).split(/\r?\n/);
				for (let i = 0; i < lines.length && out.length < MAX_MATCHES; i++) {
					if (re.test(lines[i])) out.push(`${t.rel}:${i + 1}:${lines[i]}`);
				}
			}
			return text(cap(out.join('\n')));
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
			const base = r.base;
			const matches: string[] = [];
			if (typeof fsp.glob === 'function') {
				for await (const p of fsp.glob(pattern.replace(/\\/g, '/'), { cwd: base })) {
					const posix = toPosix(String(p));
					if (posix === '.') continue;
					matches.push(posix);
					if (matches.length >= MAX_GLOB) break;
				}
			} else {
				const re = globToRegExp(pattern);
				for (const e of await walkAsync(base)) {
					if (re.test(e.rel)) matches.push(e.rel);
					if (matches.length >= MAX_GLOB) break;
				}
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
			const updated = replaceAll ? content.split(find).join(replacement) : content.replace(find, replacement);
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
			description:
				'Download a file from a URL. Defaults to a filename derived from the URL.',
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
				res = await fetch(url, {
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
				buf = Buffer.from(await res.arrayBuffer());
			} catch (e) {
				return err(`download failed: ${e instanceof Error ? e.message : String(e)}`);
			}
			if (buf.length > MAX_DOWNLOAD) return err(`file too large: ${buf.length} bytes`);
			await fsp.mkdir(path.dirname(r.abs), { recursive: true });
			await fsp.writeFile(r.abs, buf);
			return text(`${toPosix(path.relative(r.base, r.abs))} ${buf.length} bytes`);
		}
	);

	return server;
}
