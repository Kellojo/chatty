import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CallerContext } from '../types.js';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';
// The fixture server listens on 127.0.0.1, which the SSRF guard blocks by default.
process.env.ALLOW_PRIVATE_NETWORK_FETCH = 'true';

const { createWebfetchServer, extractPageMeta, pageIcons } = await import('./webfetch.js');
const { getDb } = await import('../../db/index.js');
const { findSourceSite } = await import('../../db/repo/source-sites.js');
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

const filler = (label: string) =>
	Array.from({ length: 20 }, (_, i) => `<p>${label} paragraph ${i} with enough words.</p>`).join(
		''
	);

/** A venue page: menu and footer around <main>, events in JSON-LD (one malformed block). */
const EVENTS_PAGE =
	'<html><head><title>Venue</title>' +
	'<script type="application/ld+json">{not json</script>' +
	'<script type="application/ld+json">' +
	JSON.stringify({
		'@context': 'https://schema.org',
		'@graph': [
			{ '@type': 'Organization', name: 'Venue GmbH' },
			{
				'@type': 'MusicEvent',
				name: 'Lane 8',
				startDate: '2026-11-21T22:00',
				endDate: '2026-11-22T05:00',
				location: {
					'@type': 'Place',
					name: 'Noblessneri valukoda',
					address: {
						'@type': 'PostalAddress',
						streetAddress: 'Peetri 10',
						addressLocality: 'Tallinn',
						addressCountry: { name: 'EE' }
					}
				},
				performer: [{ '@type': 'MusicGroup', name: 'Lane 8' }, 'Pyfel'],
				offers: [
					{ price: 35, priceCurrency: 'EUR', availability: 'https://schema.org/InStock' },
					{ price: 50, priceCurrency: 'EUR' }
				],
				url: '/events/lane-8'
			}
		]
	}) +
	'</script>' +
	'<script type="application/ld+json">' +
	JSON.stringify([
		{
			'@type': 'ItemList',
			itemListElement: [
				{
					'@type': 'ListItem',
					item: {
						'@type': ['Event'],
						name: 'Festival day',
						startDate: '2027-06-11',
						location: 'Glendalough Estate',
						eventStatus: 'https://schema.org/EventPostponed'
					}
				}
			]
		}
	]) +
	'</script></head><body><header><p>Site menu and login</p></header>' +
	`<main><h1>What's on</h1>${filler('Main')}</main>` +
	`<footer>${filler('Footer')}</footer></body></html>`;

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
		if (req.url === '/events') {
			res.writeHead(200, { 'content-type': 'text/html' }).end(EVENTS_PAGE);
			return;
		}
		if (req.url === '/long') {
			const lines = Array.from({ length: 400 }, (_, i) => `<p>Line ${i} of a long page.</p>`);
			res.writeHead(200, { 'content-type': 'text/html' }).end(`<body>${lines.join('')}</body>`);
			return;
		}
		if (req.url === '/moved') {
			res.writeHead(302, { location: '/article' }).end();
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

async function callFetch(args: Record<string, unknown>, ctx?: CallerContext) {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const server = createWebfetchServer(ctx);
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

	it('stops reading at the size limit and marks the end of what was read as truncated', async () => {
		const first = resultText(await callFetch({ url: `${base}/huge`, format: 'text' }));
		expect(first).toContain('chars 0–8000 of 1048576 shown');
		expect(first).toContain('start_index=8000');
		expect(first).not.toContain('… truncated');
		const last = resultText(
			await callFetch({ url: `${base}/huge`, format: 'text', start_index: 1024 * 1024 - 1000 })
		);
		expect(last.startsWith('[… continuing from char 1047576]\n\n')).toBe(true);
		expect(last.endsWith(`${'a'.repeat(1000)}\n… truncated`)).toBe(true);
	});

	it('returns a long page in windows, cut at line breaks, continued by start_index', async () => {
		const first = resultText(await callFetch({ url: `${base}/long`, max_length: 500 }));
		const next = /start_index=(\d+)/.exec(first)?.[1];
		expect(first.startsWith('Line 0 of a long page.')).toBe(true);
		expect(first).toMatch(/of a long page\.\n\n… \[chars 0–\d+ of \d+ shown/);
		const second = resultText(
			await callFetch({ url: `${base}/long`, max_length: 500, start_index: Number(next) })
		);
		expect(second).toMatch(/^\[… continuing from char \d+\]\n\nLine \d+ of a long page\./);
		const past = resultText(await callFetch({ url: `${base}/long`, start_index: 10_000_000 }));
		expect(past).toMatch(/^\[start_index 10000000 is past the end of this page/);
	});

	it("lists the page's structured-data events first, then only its main content", async () => {
		const out = resultText(await callFetch({ url: `${base}/events` }));
		const [events, content] = out.split('\n\n---\n\n');
		expect(events).toBe(
			"Events in this page's structured data (schema.org):\n" +
				`- 2026-11-21T22:00 – 2026-11-22T05:00 · Lane 8 · Noblessneri valukoda, Peetri 10, Tallinn, EE · with Lane 8, Pyfel · from 35 EUR, InStock · ${base}/events/lane-8\n` +
				'- 2027-06-11 · Festival day · Glendalough Estate · EventPostponed'
		);
		expect(content.startsWith("# What's on")).toBe(true);
		expect(content).toContain('Main paragraph 19');
		expect(content).not.toContain('Site menu');
		expect(content).not.toContain('Footer paragraph');
	});

	it('keeps the whole page when its <main> holds next to no text', async () => {
		const html = `<body><main><p>Loading…</p></main><div>${filler('Body')}</div></body>`;
		const { mainContent } = await import('./webfetch.js');
		expect(mainContent(html)).toBe(html);
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

	it('hands the source card to the chat in structuredContent, not to the model', async () => {
		const res = (await callFetch({ url: `${base}/article` })) as {
			content: Array<{ type: string; text: string }>;
			structuredContent: { sources: unknown[] };
		};
		expect(res.content).toHaveLength(1);
		expect(res.content[0].text).toContain('Article body');
		expect(res.content[0].text).not.toContain('favicon');
		expect(res.structuredContent.sources).toHaveLength(1);
		const card = res.structuredContent.sources[0];
		expect(card).toEqual({
			url: `${base}/article`,
			title: 'Rust & WebAssembly',
			site: 'The Book',
			description: 'Build fast web apps.',
			favicon: `${base}/static/icon.svg`,
			image: `${base}/img/cover.png`
		});
	});

	it('also files the card under the requested URL when the page redirected', async () => {
		const res = (await callFetch({ url: `${base}/moved` })) as {
			structuredContent: { sources: Array<{ url: string; title: string }> };
		};
		expect(res.structuredContent.sources.map((s) => [s.url, s.title])).toEqual([
			[`${base}/article`, 'Rust & WebAssembly'],
			[`${base}/moved`, 'Rust & WebAssembly']
		]);
	});

	it("records the page's site and favicon for the user's /api/favicon", async () => {
		getDb()
			.prepare(
				'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, role) VALUES (?, ?, ?, 0, 0, 0, \'user\')'
			)
			.run('u1', 'u1', 'u1@example.com');
		const ctx = { userId: 'u1', role: 'user', workspaceDir: null, documentsDir: '' };
		await callFetch({ url: `${base}/article` }, ctx);
		expect(findSourceSite(getDb(), 'u1', '127.0.0.1')).toEqual({
			host: '127.0.0.1',
			origin: base,
			faviconUrl: `${base}/static/icon.svg`
		});
		// Responses without a source card record nothing.
		await callFetch({ url: `${base}/plain` }, { ...ctx, userId: 'u2' });
		expect(findSourceSite(getDb(), 'u2', '127.0.0.1')).toBeNull();
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

	it('prefers SVG icons, then the size closest to 32px, over touch icons; skips mask icons', () => {
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

	it('falls back to apple-touch-icon, then the Windows tile image, before /favicon.ico', () => {
		const pick = (head: string) => extractPageMeta(`<head>${head}</head>`, URL_).favicon;
		expect(
			pick(
				'<link rel="mask-icon" href="/mask.svg"><link rel="apple-touch-icon-precomposed" href="/old.png">' +
					'<link rel="apple-touch-icon" sizes="180x180" href="/touch.png">'
			)
		).toBe('https://www.example.com/touch.png');
		expect(pick('<meta name="msapplication-TileImage" content="/tile.png">')).toBe(
			'https://www.example.com/tile.png'
		);
	});

	it('lists every declared icon, best first, and the web app manifest', () => {
		expect(
			pageIcons(
				'<head><meta name="msapplication-TileImage" content="/tile.png">' +
					'<link rel="manifest" href="/site.webmanifest"><link rel="apple-touch-icon" href="/touch.png">' +
					'<link rel="icon" href="/fav.ico"><link rel="icon" sizes="32x32" href="/32.png"></head>',
				URL_
			)
		).toEqual({
			icons: [
				'https://www.example.com/32.png',
				'https://www.example.com/fav.ico',
				'https://www.example.com/touch.png',
				'https://www.example.com/tile.png'
			],
			manifest: 'https://www.example.com/site.webmanifest'
		});
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
