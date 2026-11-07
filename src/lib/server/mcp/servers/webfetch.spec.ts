import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';
// The fixture server listens on 127.0.0.1, which the SSRF guard blocks by default.
process.env.ALLOW_PRIVATE_NETWORK_FETCH = 'true';

const { createWebfetchServer } = await import('./webfetch.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { createMCPClient } = await import('@ai-sdk/mcp');

const PAGE =
	'<html><head><style>body{color:red}</style><script>var x=1;</script></head>' +
	'<body><p>Hello <b>World</b></p><br><p>Second para</p></body></html>';

let httpServer: http.Server;
let base: string;

beforeAll(async () => {
	httpServer = http.createServer((req, res) => {
		if (req.url?.startsWith('/status/500')) {
			res.writeHead(500).end('oops');
			return;
		}
		if (req.url === '/huge') {
			// Streams well past the 1 MiB cap; the tool must stop reading.
			res.writeHead(200, { 'content-type': 'text/plain' });
			const chunk = 'a'.repeat(64 * 1024);
			let sent = 0;
			const pump = () => {
				while (sent < 64 && !res.destroyed) {
					sent++;
					if (!res.write(chunk)) return void res.once('drain', pump);
				}
				res.end();
			};
			pump();
			return;
		}
		if (req.url === '/plain') {
			res.writeHead(200, { 'content-type': 'text/plain' }).end('plain <b>text</b>');
			return;
		}
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE);
	});
	await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
	const addr = httpServer.address();
	base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
	await new Promise((resolve) => httpServer.close(resolve));
});

async function callFetch(args: Record<string, unknown>) {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const server = createWebfetchServer();
	await server.connect(serverTransport);
	const client = await createMCPClient({ transport: clientTransport, maxRetries: 0 });
	try {
		const tools = await client.tools();
		const tool = tools.fetch as unknown as {
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

describe('webfetch server', () => {
	it('converts HTML to markdown-ish text', async () => {
		const res = await callFetch({ url: `${base}/` });
		const out = resultText(res);
		expect(out).toContain('Hello World');
		expect(out).toContain('Second para');
		expect(out).not.toContain('<p>');
		expect(out).not.toContain('var x=1');
		expect(out).not.toContain('color:red');
	});

	it('returns raw HTML with format=html', async () => {
		const res = await callFetch({ url: `${base}/`, format: 'html' });
		expect(resultText(res)).toContain('<p>Hello <b>World</b></p>');
	});

	it('returns non-HTML content as-is', async () => {
		const res = await callFetch({ url: `${base}/plain`, format: 'text' });
		expect(resultText(res)).toContain('plain <b>text</b>');
	});

	it('truncates bodies past the size limit and marks them truncated', async () => {
		const out = resultText(await callFetch({ url: `${base}/huge`, format: 'text' }));
		expect(out.endsWith('\n… truncated')).toBe(true);
		expect(out.length).toBe(1024 * 1024 + '\n… truncated'.length);
	});

	it('does not mark small bodies as truncated', async () => {
		const out = resultText(await callFetch({ url: `${base}/plain`, format: 'text' }));
		expect(out).not.toContain('truncated');
	});

	it('reports non-2xx status as error', async () => {
		const res = await callFetch({ url: `${base}/status/500` });
		expect((res as { isError?: boolean }).isError).toBe(true);
		expect(resultText(res)).toContain('500');
	});
});
