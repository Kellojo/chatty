import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

const { createFsServer } = await import('./fs.js');
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

	it('fs_head and fs_tail slice lines', async () => {
		const head = resultText(
			await callTool('fs_head', { scope: 'workspace', path: 'big.txt', lines: 5 })
		);
		expect(head).toContain('line 01');
		expect(head).not.toContain('line 06');
		const tail = resultText(
			await callTool('fs_tail', { scope: 'workspace', path: 'big.txt', lines: 2 })
		);
		expect(tail).toContain('line 60');
		expect(tail).not.toContain('line 58');
	});

	it('fs_wc counts lines, words and bytes', async () => {
		const out = resultText(await callTool('fs_wc', { scope: 'workspace', path: 'src/b.txt' }));
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

	it('fs_glob matches relative paths', async () => {
		const res = await callTool('fs_glob', { scope: 'workspace', pattern: '**/*.md' });
		const matches = JSON.parse(resultText(res)) as string[];
		expect(matches).toContain('top.md');
		expect(matches).toContain('src/a.md');
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

		it('fs_edit replaces first occurrence and replaceAll replaces every occurrence', async () => {
			await callTool('fs_write', {
				scope: 'documents',
				path: 'edit.txt',
				content: 'foo bar foo'
			});
			expect(
				isErr(
					await callTool('fs_edit', {
						scope: 'documents',
						path: 'edit.txt',
						old: 'foo',
						new: 'baz'
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
