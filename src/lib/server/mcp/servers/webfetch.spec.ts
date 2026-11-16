import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';
// The fixture server listens on 127.0.0.1, which the SSRF guard blocks by default.
process.env.ALLOW_PRIVATE_NETWORK_FETCH = 'true';

const { createWebfetchServer, extractPageMeta } = await import('./webfetch.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { createMCPClient } = await import('@ai-sdk/mcp');

const PAGE =
	'<html><head><style>body{color:red}</style><script>var x=1;</script></head>' +
	'<body><p>Hello <b>World</b></p><br><p>Second para</p></body></html>';

const ARTICLE =
	'<html><head><title>Fallback title</title>' +
	'<meta property="og:title" content="Rust &amp; WebAssembly">' +
	'<meta property="og:site_name" content="The Book">' +
	'<meta name="description" content="Build fast   web apps.">' +
	'<link rel="icon" href="/static/icon.svg"><meta property="og:image" content="img/cover.png">' +
	'</head><body><p>Article body</p></body></html>';

const RICH =
	'<html><head><title>Rich</title></head><body><nav><a href="/home">Home</a></nav>' +
	'<h1>Main &amp; Title</h1><p>Some <strong>bold</strong> and <em>italic</em> text with ' +
	'<a href="/docs?a=1&amp;b=2">a link</a> and <code>x &lt; y</code>.</p>' +
	'<ul><li>One</li><li>Two<ol><li>Nested</li></ol></li></ul>' +
	'<pre><code class="language-js">if (a &lt; b) {\n  go();\n}</code></pre>' +
	'<p>Caf&eacute;? &copy; 2024 &#8211; &quot;quoted&quot;&nbsp;end</p></body></html>';

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
		if (req.url === '/article') {
			res.writeHead(200, { 'content-type': 'text/html' }).end(ARTICLE);
			return;
		}
		if (req.url === '/rich') {
			res.writeHead(200, { 'content-type': 'text/html' }).end(RICH);
			return;
		}
		if (req.url === '/doc.pdf') {
			res.writeHead(200, { 'content-type': 'application/pdf' }).end('%PDF-1.7 \u0000\u0001binary');
			return;
		}
		if (req.url === '/untyped') {
			res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x1a]));
			return;
		}
		if (req.url === '/json') {
			res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end('{"a":1}');
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
	it('converts HTML to markdown by default', async () => {
		const res = await callFetch({ url: `${base}/` });
		const out = resultText(res);
		expect(out).toContain('Hello **World**');
		expect(out).toContain('Second para');
		expect(out).not.toContain('<p>');
		expect(out).not.toContain('var x=1');
		expect(out).not.toContain('color:red');
	});

	it('renders headings, links, lists, emphasis and code as markdown', async () => {
		const out = resultText(await callFetch({ url: `${base}/rich`, format: 'markdown' }));
		expect(out).toContain('# Main & Title');
		expect(out).toContain('Some **bold** and *italic* text');
		expect(out).toContain(`[a link](${base}/docs?a=1&b=2)`);
		expect(out).toContain('`x < y`');
		expect(out).toContain('- One\n- Two\n  1. Nested');
		expect(out).toContain('```js\nif (a < b) {\n  go();\n}\n```');
		expect(out).toContain('Café? © 2024 – "quoted" end');
		expect(out).not.toContain('Home'); // nav is noise
		expect(out).not.toMatch(/<\/?[a-z]/i);
	});

	it('returns plain text with decoded entities for format=text', async () => {
		const out = resultText(await callFetch({ url: `${base}/rich`, format: 'text' }));
		expect(out).toContain('Main & Title');
		expect(out).not.toContain('#');
		expect(out).not.toContain('**');
		expect(out).toContain('Some bold and italic text with a link and x < y.');
		expect(out).toContain('if (a < b) {\n  go();\n}');
		expect(out).toContain('Café? © 2024 – "quoted" end');
	});

	it('refuses binary content types and points to fs_curl', async () => {
		const res = await callFetch({ url: `${base}/doc.pdf` });
		expect((res as { isError?: boolean }).isError).toBe(true);
		expect(resultText(res)).toContain('application/pdf');
		expect(resultText(res)).toContain('fs_curl');
	});

	it('refuses untyped binary bodies', async () => {
		const res = await callFetch({ url: `${base}/untyped` });
		expect((res as { isError?: boolean }).isError).toBe(true);
		expect(resultText(res)).toContain('fs_curl');
	});

	it('returns JSON responses as text', async () => {
		expect(resultText(await callFetch({ url: `${base}/json` }))).toBe('{"a":1}');
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

	it('adds a source card for HTML pages after the body', async () => {
		const res = (await callFetch({ url: `${base}/article` })) as {
			content: Array<{ type: string; text: string }>;
		};
		expect(res.content[0].text).toContain('Article body');
		const card = JSON.parse(res.content[1].text.replace(/^Source card: /, ''));
		expect(card).toEqual({
			url: `${base}/article`,
			title: 'Rust & WebAssembly',
			site: 'The Book',
			description: 'Build fast web apps.',
			favicon: `${base}/static/icon.svg`,
			image: `${base}/img/cover.png`
		});
	});

	it('adds no source card for non-HTML responses', async () => {
		const res = (await callFetch({ url: `${base}/plain` })) as { content: unknown[] };
		expect(res.content).toHaveLength(1);
	});

	it('mentions the links fence in the tool description', async () => {
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const server = createWebfetchServer();
		await server.connect(serverTransport);
		const client = await createMCPClient({ transport: clientTransport, maxRetries: 0 });
		try {
			const tools = await client.tools();
			expect(tools.fetch.description).toContain('```links');
		} finally {
			await client.close();
			await server.close();
		}
	});
});

describe('extractPageMeta', () => {
	const URL_ = 'https://www.example.com/docs/page';

	it('falls back to <title>, meta description and /favicon.ico', () => {
		const meta = extractPageMeta(
			'<head><TITLE>\n  Hello &#8211; World </TITLE><meta content="Plain desc" name="Description"></head>',
			URL_
		);
		expect(meta).toEqual({
			url: URL_,
			title: 'Hello – World',
			description: 'Plain desc',
			favicon: 'https://www.example.com/favicon.ico'
		});
	});

	it('uses the hostname when the page has no title', () => {
		expect(extractPageMeta('<p>no head</p>', URL_).title).toBe('example.com');
	});

	it('prefers SVG icons, then the size closest to 32px, and skips mask/touch icons', () => {
		const pick = (links: string) => extractPageMeta(`<head>${links}</head>`, URL_).favicon;
		expect(
			pick(
				'<link rel="apple-touch-icon" href="/apple.png"><link rel="mask-icon" href="/mask.svg">' +
					'<link rel="icon" sizes="16x16" href="/16.png"><link rel="icon" sizes="32x32" href="/32.png">'
			)
		).toBe('https://www.example.com/32.png');
		expect(
			pick(
				'<link rel="shortcut icon" href="a.ico"><link rel="icon" type="image/svg+xml" href="b.svg">'
			)
		).toBe('https://www.example.com/docs/b.svg');
	});

	it('resolves relative URLs against <base href> and drops non-http ones', () => {
		const meta = extractPageMeta(
			'<head><base href="https://cdn.example.org/assets/"><link rel=icon href=fav.png>' +
				'<meta property="og:image" content="javascript:alert(1)"></head>',
			URL_
		);
		expect(meta.favicon).toBe('https://cdn.example.org/assets/fav.png');
		expect(meta.image).toBeUndefined();
	});

	it('ignores tags in the body and caps long descriptions on a word boundary', () => {
		const long = 'word '.repeat(80);
		const meta = extractPageMeta(
			`<head><meta property="og:description" content="${long}"></head><body><meta property="og:site_name" content="Nope"></body>`,
			URL_
		);
		expect(meta.site).toBeUndefined();
		expect(meta.description!.length).toBeLessThanOrEqual(201);
		expect(meta.description!.endsWith('word…')).toBe(true);
	});
});
