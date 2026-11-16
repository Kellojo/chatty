import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
delete process.env.ALLOW_PRIVATE_NETWORK_FETCH;

const { getDb } = await import('$lib/server/db/index.js');
const { rememberSourceSite } = await import('$lib/server/db/repo/source-sites.js');
const { clearIconCache, ICON_TTL_MS, loadSiteIcon } = await import('$lib/server/net/favicon.js');
const { getCachedFavicon } = await import('$lib/server/db/repo/favicon-cache.js');
const { GET } = await import('./+server.js');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

beforeAll(() => {
	const db = getDb();
	for (const id of ['u1', 'u2']) {
		db.prepare(
			'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, role) VALUES (?, ?, ?, 0, 0, 0, \'user\')'
		).run(id, id, `${id}@example.com`);
	}
	rememberSourceSite(
		db,
		'u1',
		'https://www.dictionary.example/word',
		'https://cdn.example/icon.png'
	);
	rememberSourceSite(db, 'u1', 'https://bare.example/page');
	rememberSourceSite(db, 'u1', 'https://hidden.example/article');
	rememberSourceSite(db, 'u1', 'http://127.0.0.1:8080/admin', 'http://127.0.0.1:8080/icon.png');
	rememberSourceSite(db, 'u1', 'https://metadata.example/', 'http://169.254.169.254/latest');
});

const fetchMock = vi.fn<typeof fetch>();
const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
	fetchMock.mockReset();
	clearIconCache();
});

function stubFetch(impl: (url: string) => Response) {
	fetchMock.mockImplementation(async (input) => impl(String(input)));
	globalThis.fetch = fetchMock;
}

function call(host: string, locals: object = { user: { id: 'u1' } }) {
	const url = new URL(`http://localhost/api/favicon?host=${encodeURIComponent(host)}`);
	return Promise.resolve(GET({ url, locals } as never));
}

describe('GET /api/favicon', () => {
	it('requires a signed-in user', async () => {
		await expect(call('dictionary.example', {})).rejects.toMatchObject({ status: 401 });
	});

	it('serves the declared icon of a site the user fetched, as a sandboxed image', async () => {
		stubFetch(() => new Response(PNG, { headers: { 'content-type': 'image/png' } }));
		const res = await call('dictionary.example');
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('image/png');
		expect(res.headers.get('x-content-type-options')).toBe('nosniff');
		expect(res.headers.get('content-security-policy')).toContain('sandbox');
		expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG);
		expect(String(fetchMock.mock.calls[0][0])).toBe('https://cdn.example/icon.png');
		// No cookies or credentials go out with the request.
		const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
		expect(headers.has('cookie')).toBe(false);
		expect(headers.has('authorization')).toBe(false);
		// Cached: a second request doesn't fetch again.
		expect((await call('www.dictionary.example')).status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('falls back to /favicon.ico and sniffs untyped icons', async () => {
		const ico = Buffer.from([0, 0, 1, 0, 1, 0, 16, 16]);
		stubFetch((url) =>
			url.endsWith('/favicon.ico')
				? new Response(ico, { headers: { 'content-type': 'application/octet-stream' } })
				: new Response('nope', { status: 404 })
		);
		const res = await call('bare.example');
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('image/x-icon');
		expect(String(fetchMock.mock.calls[0][0])).toBe('https://bare.example/favicon.ico');
	});

	it('404s on hosts the user never fetched, without any request', async () => {
		stubFetch(() => new Response(PNG, { headers: { 'content-type': 'image/png' } }));
		for (const host of ['secret-chat-data.evil.example', '', 'x'.repeat(300)]) {
			const res = await call(host);
			expect(res.status).toBe(404);
			expect(res.body).toBeNull();
		}
		// Another user's sites aren't shared.
		expect((await call('dictionary.example', { user: { id: 'u2' } })).status).toBe(404);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('refuses private and link-local addresses', async () => {
		stubFetch(() => new Response(PNG, { headers: { 'content-type': 'image/png' } }));
		expect((await call('127.0.0.1')).status).toBe(404);
		// The declared icon points at cloud metadata and is refused; the public /favicon.ico fallback loads.
		expect((await call('metadata.example')).status).toBe(200);
		expect(fetchMock.mock.calls.map(([u]) => String(u))).toEqual([
			'https://metadata.example/favicon.ico'
		]);
	});

	it('rejects responses that are not images', async () => {
		stubFetch(
			() => new Response('<html>Not found</html>', { headers: { 'content-type': 'text/html' } })
		);
		expect((await call('dictionary.example')).status).toBe(404);
		stubFetch(() => new Response('<html>hi</html>', { headers: { 'content-type': 'text/plain' } }));
		clearIconCache();
		expect((await call('dictionary.example')).status).toBe(404);
	});

	it('rejects icons over the size cap', async () => {
		stubFetch(
			() =>
				new Response(Buffer.concat([PNG, Buffer.alloc(300 * 1024)]), {
					headers: { 'content-type': 'image/png' }
				})
		);
		expect((await call('dictionary.example')).status).toBe(404);
	});

	it("finds icons the home page or its manifest declares when the usual ones don't load", async () => {
		const home =
			'<html><head><link rel="manifest" href="/app.webmanifest">' +
			'<link rel="apple-touch-icon" href="/static/touch.png"></head><body></body></html>';
		const manifest = JSON.stringify({ icons: [{ src: '/icons/192.png', sizes: '192x192' }] });
		const routes = (served: string) => (url: string) =>
			url === 'https://hidden.example/'
				? new Response(home, { headers: { 'content-type': 'text/html' } })
				: url === 'https://hidden.example/app.webmanifest'
					? new Response(manifest, { headers: { 'content-type': 'application/manifest+json' } })
					: url === served
						? new Response(PNG, { headers: { 'content-type': 'image/png' } })
						: new Response('missing', { status: 404 });
		stubFetch(routes('https://hidden.example/static/touch.png'));
		expect((await call('hidden.example')).status).toBe(200);
		expect(fetchMock.mock.calls.map(([u]) => String(u))).toEqual([
			'https://hidden.example/favicon.ico',
			'https://hidden.example/',
			'https://hidden.example/static/touch.png'
		]);

		// No usable link icons: the manifest's icons are next.
		clearIconCache();
		fetchMock.mockClear();
		stubFetch(routes('https://hidden.example/icons/192.png'));
		expect((await call('hidden.example')).status).toBe(200);
		expect(fetchMock.mock.calls.map(([u]) => String(u)).slice(-2)).toEqual([
			'https://hidden.example/app.webmanifest',
			'https://hidden.example/icons/192.png'
		]);
	});

	it('keeps found icons in the database for a month', async () => {
		const site = { host: 'bare.example', origin: 'https://bare.example', faviconUrl: null };
		const now = Date.now();
		const day = 24 * 60 * 60_000;
		stubFetch(() => new Response(PNG, { headers: { 'content-type': 'image/png' } }));
		await loadSiteIcon(site, { now });
		expect(getCachedFavicon(getDb(), 'bare.example')).toMatchObject({
			type: 'image/png',
			fetchedAt: now
		});
		// Still fresh after 29 days: served from the database without a request.
		expect(await loadSiteIcon(site, { now: now + 29 * day })).toEqual({
			body: PNG,
			type: 'image/png'
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		// Expired: fetched again; if the site is down by then, the old icon is still served.
		stubFetch(() => new Response('down', { status: 503 }));
		expect(await loadSiteIcon(site, { now: now + ICON_TTL_MS + 1 })).toEqual({
			body: PNG,
			type: 'image/png'
		});
		expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
	});

	it('remembers sites without an icon for a while instead of searching on every request', async () => {
		stubFetch(() => new Response('missing', { status: 404 }));
		expect((await call('bare.example')).status).toBe(404);
		const calls = fetchMock.mock.calls.length;
		expect(calls).toBeGreaterThan(0);
		expect((await call('bare.example')).status).toBe(404);
		expect(fetchMock.mock.calls.length).toBe(calls);
	});
});
