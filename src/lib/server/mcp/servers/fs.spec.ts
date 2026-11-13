import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

const { createFsServer, globMatcher, grepInWorker } = await import('./fs.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { createMCPClient } = await import('@ai-sdk/mcp');

const B_TXT = 'alpha\nbeta needle gamma\ndelta\n';

let workspaceDir: string;
let documentsDir: string;
let ctx: { userId: string; role: string; workspaceDir: string | null; documentsDir: string };

beforeAll(() => {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-fs-'));
	workspaceDir = path.join(base, 'ws');
	documentsDir = path.join(base, 'docs');
	fs.mkdirSync(path.join(workspaceDir, 'src'), { recursive: true });
	fs.writeFileSync(path.join(workspaceDir, 'src', 'a.md'), '# Title\nline two\n');
	fs.writeFileSync(path.join(workspaceDir, 'src', 'b.txt'), B_TXT);
	fs.writeFileSync(path.join(workspaceDir, 'top.md'), '# top\n');
	const big = Array.from({ length: 60 }, (_, i) => `line ${String(i + 1).padStart(2, '0')}`).join(
		'\n'
	);
	fs.writeFileSync(path.join(workspaceDir, 'big.txt'), big);
	ctx = { userId: 'u1', role: 'user', workspaceDir, documentsDir };
});

async function callTool(name: string, args: Record<string, unknown>, c: typeof ctx = ctx) {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const server = createFsServer(c);
	await server.connect(serverTransport);
	const client = await createMCPClient({ transport: clientTransport, maxRetries: 0 });
	try {
		const tools = await client.tools();
		const tool = tools[name] as unknown as {
			execute: (input: unknown, opts: unknown) => Promise<unknown>;
		};
		return await tool.execute(args, { toolCallId: 't1', messages: [] });
	} finally {
		await client.close();
		await server.close();
	}
}

function resultText(res: unknown): string {
	const r = res as { content?: Array<{ type: string; text?: string }> };
	return r.content?.[0]?.text ?? '';
}

function cap(out: string): string {
	return out.length > 64 * 1024 ? `${out.slice(0, 64 * 1024)}\n… truncated` : out;
}

function isErr(res: unknown): boolean {
	return (res as { isError?: boolean }).isError === true;
}

describe('fs server', () => {
	it('fs_ls lists directories first', async () => {
		const out = resultText(await callTool('fs_ls', { scope: 'workspace' })).split('\n');
		expect(out).toContain('src/');
		expect(out).toContain('top.md');
		expect(out.indexOf('src/')).toBeLessThan(out.indexOf('top.md'));
	});

	it('fs_read prints file content', async () => {
		expect(resultText(await callTool('fs_read', { scope: 'workspace', path: 'src/b.txt' }))).toBe(
			B_TXT
		);
	});

	it('fs_read head and tail slice lines', async () => {
		const head = resultText(
			await callTool('fs_read', { scope: 'workspace', path: 'big.txt', head: 5 })
		);
		expect(head).toContain('line 01');
		expect(head).not.toContain('line 06');
		const tail = resultText(
			await callTool('fs_read', { scope: 'workspace', path: 'big.txt', tail: 2 })
		);
		expect(tail).toContain('line 60');
		expect(tail).not.toContain('line 58');
	});

	it('fs_read stats counts lines, words and bytes', async () => {
		const out = resultText(
			await callTool('fs_read', { scope: 'workspace', path: 'src/b.txt', stats: true })
		);
		expect(out).toBe(`3 5 ${Buffer.byteLength(B_TXT)} src/b.txt`);
	});

	it('fs_grep finds lines with path:lineNo and honours ignoreCase', async () => {
		const out = resultText(await callTool('fs_grep', { scope: 'workspace', pattern: 'needle' }));
		expect(out).toContain('src/b.txt:2:beta needle gamma');
		expect(out).not.toContain('alpha');
		const ci = resultText(
			await callTool('fs_grep', { scope: 'workspace', pattern: 'NEEDLE', ignoreCase: true })
		);
		expect(ci).toContain('src/b.txt:2:beta needle gamma');
	});

	it('fs_grep rejects invalid regex', async () => {
		expect(isErr(await callTool('fs_grep', { scope: 'workspace', pattern: '(' }))).toBe(true);
	});

	it('fs_grep rejects overly long patterns', async () => {
		const res = await callTool('fs_grep', { scope: 'workspace', pattern: 'a'.repeat(1001) });
		expect(isErr(res)).toBe(true);
		expect(resultText(res)).toContain('pattern too long');
	});

	it('grepInWorker times out a catastrophic pattern without blocking the event loop', async () => {
		const file = path.join(workspaceDir, 'redos.txt');
		fs.writeFileSync(file, `${'a'.repeat(5000)}!\n`);
		let ticks = 0;
		const interval = setInterval(() => ticks++, 10);
		const started = Date.now();
		try {
			const res = await grepInWorker(
				{
					pattern: '(a+)+$',
					flags: '',
					files: [{ abs: file, rel: 'redos.txt' }],
					maxMatches: 10,
					maxLine: 10_000
				},
				300
			);
			expect(res).toEqual({ ok: false, error: 'pattern timed out after 0.3s' });
			expect(Date.now() - started).toBeLessThan(5000);
			// The main loop kept running while the worker was stuck.
			expect(ticks).toBeGreaterThan(5);
		} finally {
			clearInterval(interval);
			fs.rmSync(file);
		}
	});

	it('grepInWorker caps the line length it tests', async () => {
		const file = path.join(workspaceDir, 'longline.txt');
		fs.writeFileSync(file, `${'x'.repeat(50)}needle\nneedle\n`);
		try {
			const res = await grepInWorker({
				pattern: 'needle',
				flags: '',
				files: [{ abs: file, rel: 'longline.txt' }],
				maxMatches: 10,
				maxLine: 20
			});
			expect(res).toEqual({ ok: true, lines: ['longline.txt:2:needle'] });
		} finally {
			fs.rmSync(file);
		}
	});

	describe('globMatcher', () => {
		it.each([
			['*.md', 'a.md', true],
			['*.md', 'src/a.md', false],
			['src/?.md', 'src/a.md', true],
			['src/?.md', 'src/ab.md', false],
			['**/*.md', 'top.md', true],
			['**/*.md', 'src/deep/a.md', true],
			['src/**', 'src/a/b', true],
			['src/**', 'src', false],
			['src**', 'src/a/b', true],
			['a/**/b', 'a/b', true],
			['a/**/b', 'a/x/y/b', true],
			['a/**/b', 'a/xb', false],
			['a.b', 'axb', false],
			['{a,b}', '{a,b}', true],
			['(x)+', '(x)+', true]
		])('%s against %s -> %s', (glob, p, expected) => {
			expect(globMatcher(glob)(p)).toBe(expected);
		});

		it('stays fast on patterns that backtrack badly as a regex', () => {
			const started = Date.now();
			const match = globMatcher(`${'*a'.repeat(30)}*b`);
			expect(match(`${'a'.repeat(4000)}c`)).toBe(false);
			const deep = globMatcher(`${'**/a'.repeat(30)}/b`);
			expect(deep(`${'a/'.repeat(2000)}c`)).toBe(false);
			expect(Date.now() - started).toBeLessThan(2000);
		});
	});

	describe('bounded reads and walks', () => {
		let dir: string;
		let bctx: typeof ctx;
		const call = (name: string, args: Record<string, unknown>) =>
			callTool(name, { scope: 'workspace', ...args }, bctx);

		// What fs_read returned when it loaded the whole file.
		const wholeHead = (s: string, n: number) => s.split(/\r?\n/).slice(0, n).join('\n');
		const wholeTail = (s: string, n: number) => {
			const all = s.split(/\r?\n/);
			return all.slice(Math.max(0, all.length - n)).join('\n');
		};
		const wholeStats = (s: string) =>
			`${s === '' ? 0 : (s.match(/\n/g)?.length ?? 0)} ${s.split(/\s+/).filter(Boolean).length} ${Buffer.byteLength(s)}`;

		beforeAll(() => {
			dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-fs-bounded-'));
			bctx = { ...ctx, workspaceDir: dir };
		});

		it('fs_read head/tail/stats match whole-file results across chunk boundaries', async () => {
			// ~200KB of CRLF lines with multi-byte chars and words straddling 64KB chunks.
			const lines = Array.from(
				{ length: 4000 },
				(_, i) => `\u00a0zeile ${i} äöü 😀 longwordlongwordlongword${i}\tend`
			);
			const content = `\ufeff${lines.join('\r\n')}\r\n`;
			fs.writeFileSync(path.join(dir, 'crlf.txt'), content);
			for (const n of [0, 1, 7, 2000, 3999, 4000, 4001, 10_000]) {
				expect(resultText(await call('fs_read', { path: 'crlf.txt', head: n }))).toBe(
					cap(wholeHead(content, n))
				);
				expect(resultText(await call('fs_read', { path: 'crlf.txt', tail: n }))).toBe(
					cap(wholeTail(content, n))
				);
			}
			expect(resultText(await call('fs_read', { path: 'crlf.txt', stats: true }))).toBe(
				`${wholeStats(content)} crlf.txt`
			);
		});

		it('fs_read tail handles a missing trailing newline and an empty file', async () => {
			fs.writeFileSync(path.join(dir, 'nonl.txt'), 'a\nb\nc');
			fs.writeFileSync(path.join(dir, 'empty.txt'), '');
			expect(resultText(await call('fs_read', { path: 'nonl.txt', tail: 2 }))).toBe('b\nc');
			expect(resultText(await call('fs_read', { path: 'nonl.txt', tail: 9 }))).toBe('a\nb\nc');
			expect(resultText(await call('fs_read', { path: 'empty.txt', tail: 3 }))).toBe('');
			expect(resultText(await call('fs_read', { path: 'empty.txt', stats: true }))).toBe(
				'0 0 0 empty.txt'
			);
		});

		it('fs_read truncates files over 1MB and rejects directories', async () => {
			fs.writeFileSync(path.join(dir, 'huge.txt'), 'x'.repeat(3 * 1024 * 1024));
			const out = resultText(await call('fs_read', { path: 'huge.txt' }));
			expect(out).toBe(`${'x'.repeat(1024 * 1024)}\n… truncated`);
			fs.mkdirSync(path.join(dir, 'adir'), { recursive: true });
			const res = await call('fs_read', { path: 'adir' });
			expect(isErr(res)).toBe(true);
			expect(resultText(res)).toContain('not a file');
		});

		it('fs_grep skips heavy and binary files unless the path points inside', async () => {
			fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
			fs.mkdirSync(path.join(dir, 'lib', '.git'), { recursive: true });
			fs.writeFileSync(path.join(dir, 'node_modules', 'pkg', 'i.js'), 'grepme\n');
			fs.writeFileSync(path.join(dir, 'lib', '.git', 'HEAD'), 'grepme\n');
			fs.writeFileSync(path.join(dir, 'lib', 'ok.txt'), 'grepme\n');
			fs.writeFileSync(path.join(dir, 'lib', 'bin.dat'), Buffer.from('grepme\0\n'));
			const out = resultText(await call('fs_grep', { pattern: 'grepme' }));
			expect(out).toBe('lib/ok.txt:1:grepme');
			const inside = resultText(await call('fs_grep', { pattern: 'grepme', path: 'node_modules' }));
			expect(inside).toBe('node_modules/pkg/i.js:1:grepme');
		});

		it('fs_grep refuses an explicit file over the scan limit', async () => {
			fs.writeFileSync(path.join(dir, 'scan-big.txt'), Buffer.alloc(5 * 1024 * 1024 + 1, 97));
			const res = await call('fs_grep', { pattern: 'a', path: 'scan-big.txt' });
			expect(isErr(res)).toBe(true);
			expect(resultText(res)).toContain('file too large to search');
		});

		it('fs_grep stops after 5000 files and says so', { timeout: 60_000 }, async () => {
			const many = path.join(dir, 'many');
			fs.mkdirSync(many, { recursive: true });
			await Promise.all(
				Array.from({ length: 5001 }, (_, i) =>
					fs.promises.writeFile(path.join(many, `f${i}.txt`), 'nothing here\n')
				)
			);
			const out = resultText(await call('fs_grep', { pattern: 'zzz', path: 'many' }));
			expect(out).toContain('searched only the first 5000 files');
		});

		it('fs_glob skips heavy dirs unless the pattern names them', async () => {
			const all = JSON.parse(resultText(await call('fs_glob', { pattern: '**/*.js' })));
			expect(all).toEqual([]);
			const named = JSON.parse(
				resultText(await call('fs_glob', { pattern: 'node_modules/**/*.js' }))
			);
			expect(named).toEqual(['node_modules/pkg/i.js']);
			const deep = JSON.parse(resultText(await call('fs_glob', { pattern: '**/.git/*' })));
			expect(deep).toEqual(['lib/.git/HEAD']);
		});

		it('fs_glob walks only below the literal prefix', async () => {
			expect(JSON.parse(resultText(await call('fs_glob', { pattern: 'lib/*.txt' })))).toEqual([
				'lib/ok.txt'
			]);
			expect(JSON.parse(resultText(await call('fs_glob', { pattern: 'lib/ok.txt' })))).toEqual([
				'lib/ok.txt'
			]);
			expect(resultText(await call('fs_glob', { pattern: 'missing/**' }))).toBe('[]');
			expect(resultText(await call('fs_glob', { pattern: 'lib/ok.txt/*' }))).toBe('[]');
		});
	});

	it('fs_glob matches relative paths', async () => {
		const res = await callTool('fs_glob', { scope: 'workspace', pattern: '**/*.md' });
		const matches = JSON.parse(resultText(res)) as string[];
		expect(matches).toContain('top.md');
		expect(matches).toContain('src/a.md');
	});

	it('fs_glob accepts a leading ./ and matches single-level wildcards', async () => {
		const res = await callTool('fs_glob', { scope: 'workspace', pattern: './src/*.md' });
		expect(JSON.parse(resultText(res))).toEqual(['src/a.md']);
	});

	it.each(['../*', '../../**', 'src/../../*', '..', '/*', '/etc/*', 'C:/*', '..\\*'])(
		'fs_glob rejects the escaping pattern %s',
		async (pattern) => {
			const res = await callTool('fs_glob', { scope: 'workspace', pattern });
			expect(isErr(res)).toBe(true);
			expect(resultText(res)).toContain('escapes workspace root');
		}
	);

	it('fs_glob cannot leave the root through brace expansion', async () => {
		fs.writeFileSync(path.join(workspaceDir, '..', 'outside.txt'), 'secret');
		const res = await callTool('fs_glob', { scope: 'workspace', pattern: '{..,src}/*' });
		expect(resultText(res)).not.toContain('outside.txt');
	});

	it('rejects paths escaping the scope root', async () => {
		expect(isErr(await callTool('fs_read', { scope: 'workspace', path: '../outside.txt' }))).toBe(
			true
		);
		expect(isErr(await callTool('fs_ls', { scope: 'documents', path: '..' }))).toBe(true);
		expect(
			isErr(await callTool('fs_write', { scope: 'workspace', path: '../evil', content: 'x' }))
		).toBe(true);
	});

	it('errors when no workspace is available', async () => {
		const noWs = { ...ctx, workspaceDir: null };
		const res = await callTool('fs_ls', { scope: 'workspace' }, noWs);
		expect(isErr(res)).toBe(true);
		expect(resultText(res)).toContain('no workspace available');
		const docRes = await callTool('fs_ls', { scope: 'documents' }, noWs);
		expect(isErr(docRes)).toBe(false);
	});

	describe('write/edit/mkdir/rm', () => {
		it('fs_write creates and overwrites, honouring overwrite=false', async () => {
			expect(
				isErr(
					await callTool('fs_write', {
						scope: 'documents',
						path: 'notes/a.txt',
						content: 'hello'
					})
				)
			).toBe(false);
			expect(fs.readFileSync(path.join(documentsDir, 'notes', 'a.txt'), 'utf-8')).toBe('hello');

			const noOverwrite = await callTool('fs_write', {
				scope: 'documents',
				path: 'notes/a.txt',
				content: 'again',
				overwrite: false
			});
			expect(isErr(noOverwrite)).toBe(true);
			expect(fs.readFileSync(path.join(documentsDir, 'notes', 'a.txt'), 'utf-8')).toBe('hello');

			expect(
				isErr(
					await callTool('fs_write', {
						scope: 'documents',
						path: 'notes/a.txt',
						content: 'updated'
					})
				)
			).toBe(false);
			expect(fs.readFileSync(path.join(documentsDir, 'notes', 'a.txt'), 'utf-8')).toBe('updated');
		});

		it('fs_edit needs a unique match unless replaceAll is set', async () => {
			await callTool('fs_write', {
				scope: 'documents',
				path: 'edit.txt',
				content: 'foo bar foo'
			});
			expect(
				isErr(
					await callTool('fs_edit', { scope: 'documents', path: 'edit.txt', old: 'foo', new: 'x' })
				)
			).toBe(true);
			expect(
				isErr(
					await callTool('fs_edit', {
						scope: 'documents',
						path: 'edit.txt',
						old: 'foo bar',
						new: 'baz bar'
					})
				)
			).toBe(false);
			expect(fs.readFileSync(path.join(documentsDir, 'edit.txt'), 'utf-8')).toBe('baz bar foo');

			expect(
				isErr(
					await callTool('fs_edit', {
						scope: 'documents',
						path: 'edit.txt',
						old: 'foo',
						new: 'qux',
						replaceAll: true
					})
				)
			).toBe(false);
			expect(fs.readFileSync(path.join(documentsDir, 'edit.txt'), 'utf-8')).toBe('baz bar qux');

			expect(
				isErr(
					await callTool('fs_edit', {
						scope: 'documents',
						path: 'edit.txt',
						old: 'missing',
						new: 'x'
					})
				)
			).toBe(true);
		});

		it('fs_mkdir creates nested directories and fs_rm deletes recursively', async () => {
			expect(isErr(await callTool('fs_mkdir', { scope: 'documents', path: 'x/y/z' }))).toBe(false);
			expect(fs.existsSync(path.join(documentsDir, 'x', 'y', 'z'))).toBe(true);

			expect(
				isErr(
					await callTool('fs_write', { scope: 'documents', path: 'x/y/z/f.txt', content: 'data' })
				)
			).toBe(false);
			expect(isErr(await callTool('fs_rm', { scope: 'documents', path: 'x/y' }))).toBe(false);
			expect(fs.existsSync(path.join(documentsDir, 'x', 'y'))).toBe(false);
		});

		it('fs_edit keeps $ patterns in the new text literal', async () => {
			await callTool('fs_write', { scope: 'documents', path: 'sh.txt', content: 'echo X' });
			await callTool('fs_edit', { scope: 'documents', path: 'sh.txt', old: 'X', new: '$& $$1' });
			expect(fs.readFileSync(path.join(documentsDir, 'sh.txt'), 'utf-8')).toBe('echo $& $$1');
		});

		it('fs_rm refuses the root and reports missing paths', async () => {
			expect(isErr(await callTool('fs_rm', { scope: 'documents', path: '.' }))).toBe(true);
			expect(fs.existsSync(documentsDir)).toBe(true);
			expect(isErr(await callTool('fs_rm', { scope: 'documents', path: 'nope.txt' }))).toBe(true);
		});
	});

	it('isolates documents between per-user directories', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-fs-iso-'));
		const userA = {
			userId: 'ua',
			role: 'user',
			workspaceDir: null,
			documentsDir: path.join(root, 'ua')
		};
		const userB = {
			userId: 'ub',
			role: 'user',
			workspaceDir: null,
			documentsDir: path.join(root, 'ub')
		};

		expect(
			isErr(
				await callTool(
					'fs_write',
					{ scope: 'documents', path: 'secret.txt', content: 'for a only' },
					userA
				)
			)
		).toBe(false);

		expect(
			resultText(await callTool('fs_read', { scope: 'documents', path: 'secret.txt' }, userA))
		).toBe('for a only');
		expect(
			isErr(await callTool('fs_read', { scope: 'documents', path: 'secret.txt' }, userB))
		).toBe(true);

		const listB = resultText(await callTool('fs_ls', { scope: 'documents' }, userB));
		expect(listB).not.toContain('secret.txt');

		const grepB = resultText(
			await callTool('fs_grep', { scope: 'documents', pattern: 'for a only' }, userB)
		);
		expect(grepB).not.toContain('secret.txt');

		expect(
			isErr(
				await callTool(
					'fs_write',
					{ scope: 'documents', path: 'secret.txt', content: 'hijack' },
					userB
				)
			)
		).toBe(false);
		expect(fs.existsSync(path.join(root, 'ua', 'secret.txt'))).toBe(true);
		expect(fs.readFileSync(path.join(root, 'ub', 'secret.txt'), 'utf-8')).toBe('hijack');
	});

	it('keeps workspace and documents separate', async () => {
		await callTool('fs_write', { scope: 'workspace', path: 'only-ws.txt', content: 'ws' });
		await callTool('fs_write', { scope: 'documents', path: 'only-docs.txt', content: 'docs' });

		expect(isErr(await callTool('fs_read', { scope: 'documents', path: 'only-ws.txt' }))).toBe(
			true
		);
		expect(isErr(await callTool('fs_read', { scope: 'workspace', path: 'only-docs.txt' }))).toBe(
			true
		);
	});

	describe('fs_curl', () => {
		const realFetch = globalThis.fetch;
		afterEach(() => {
			globalThis.fetch = realFetch;
		});

		function mockFetch(body: BodyInit, init: ResponseInit = {}) {
			globalThis.fetch = vi.fn().mockResolvedValue(new Response(body, init)) as typeof fetch;
		}

		it('downloads a file derived from the URL filename', async () => {
			mockFetch('hello world');
			const res = await callTool('fs_curl', {
				scope: 'workspace',
				url: 'https://example.com/files/data.txt'
			});
			expect(isErr(res)).toBe(false);
			expect(resultText(res)).toContain('data.txt');
			expect(fs.readFileSync(path.join(workspaceDir, 'data.txt'), 'utf-8')).toBe('hello world');
		});

		it('uses an explicit destination path and creates directories', async () => {
			mockFetch('nested');
			const res = await callTool('fs_curl', {
				scope: 'documents',
				url: 'https://example.com/x.bin',
				path: 'out/deep/f.bin'
			});
			expect(isErr(res)).toBe(false);
			expect(fs.readFileSync(path.join(documentsDir, 'out', 'deep', 'f.bin'), 'utf-8')).toBe(
				'nested'
			);
		});

		it('errors on non-ok status and unsupported protocols', async () => {
			mockFetch('nope', { status: 404, statusText: 'Not Found' });
			const res = await callTool('fs_curl', {
				scope: 'workspace',
				url: 'https://example.com/missing'
			});
			expect(isErr(res)).toBe(true);
			expect(resultText(res)).toContain('404');

			expect(
				isErr(await callTool('fs_curl', { scope: 'workspace', url: 'ftp://example.com/x' }))
			).toBe(true);
		});

		it('aborts a body that streams past the limit without a content-length', async () => {
			let pulled = 0;
			let cancelled = false;
			const chunk = new Uint8Array(1024 * 1024);
			const stream = new ReadableStream<Uint8Array>({
				pull(controller) {
					pulled++;
					controller.enqueue(chunk);
				},
				cancel() {
					cancelled = true;
				}
			});
			mockFetch(stream);
			const res = await callTool('fs_curl', {
				scope: 'workspace',
				url: 'https://example.com/endless.bin'
			});
			expect(isErr(res)).toBe(true);
			expect(resultText(res)).toContain('file too large');
			expect(cancelled).toBe(true);
			expect(pulled).toBeLessThan(110);
			expect(fs.existsSync(path.join(workspaceDir, 'endless.bin'))).toBe(false);
		});

		it('rejects paths escaping the scope root', async () => {
			mockFetch('x');
			expect(
				isErr(
					await callTool('fs_curl', {
						scope: 'workspace',
						url: 'https://example.com/x',
						path: '../evil'
					})
				)
			).toBe(true);
		});

		it('errors when no workspace is available', async () => {
			mockFetch('x');
			const res = await callTool(
				'fs_curl',
				{ scope: 'workspace', url: 'https://example.com/x' },
				{ ...ctx, workspaceDir: null }
			);
			expect(isErr(res)).toBe(true);
			expect(resultText(res)).toContain('no workspace available');
		});
	});
});
