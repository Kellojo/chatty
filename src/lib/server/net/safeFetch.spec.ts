import { afterEach, describe, expect, it, vi } from 'vitest';

vi.resetModules();
delete process.env.ALLOW_PRIVATE_NETWORK_FETCH;
const { isBlockedAddress, isLinkLocalOrReserved, safeFetch } = await import('./safeFetch.js');

describe('isBlockedAddress', () => {
	it.each([
		'127.0.0.1',
		'10.1.2.3',
		'172.16.0.1',
		'192.168.1.1',
		'169.254.169.254',
		'100.64.0.1',
		'0.0.0.0',
		'::1',
		'::',
		'::ffff:127.0.0.1',
		'::ffff:7f00:1',
		'fd00::1',
		'fe80::1',
		'not-an-ip'
	])('blocks %s', (ip) => {
		expect(isBlockedAddress(ip)).toBe(true);
	});

	it.each(['1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '::ffff:1.1.1.1'])(
		'allows %s',
		(ip) => {
			expect(isBlockedAddress(ip)).toBe(false);
		}
	);
});

describe('isLinkLocalOrReserved', () => {
	it('blocks metadata and link-local but allows loopback, LAN and tailnet', () => {
		for (const ip of ['169.254.169.254', '::ffff:169.254.169.254', 'fe80::1', '0.0.0.0', '::']) {
			expect(isLinkLocalOrReserved(ip)).toBe(true);
		}
		for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.2', '100.101.102.103', '::1']) {
			expect(isLinkLocalOrReserved(ip)).toBe(false);
		}
	});
});

describe('safeFetch', () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	it.each([
		'http://127.0.0.1/',
		'http://[::1]/',
		'http://169.254.169.254/latest/meta-data/',
		'http://2130706433:8080/',
		'http://localhost:8080/'
	])('refuses %s', async (url) => {
		await expect(safeFetch(url)).rejects.toThrow(/private or reserved/);
	});

	it('refuses non-http protocols', async () => {
		await expect(safeFetch('file:///etc/passwd')).rejects.toThrow(/unsupported protocol/);
	});

	it('re-checks redirect targets and strips credentials across origins', async () => {
		const seen: Array<{ url: string; auth: string | null }> = [];
		globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			seen.push({ url, auth: new Headers(init?.headers).get('authorization') });
			if (url === 'https://public.example/a') {
				return new Response(null, {
					status: 302,
					headers: { location: 'https://other.example/b' }
				});
			}
			return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } });
		}) as typeof fetch;

		await expect(
			safeFetch('https://public.example/a', { headers: { authorization: 'Bearer x' } })
		).rejects.toThrow(/private or reserved/);
		expect(seen).toEqual([
			{ url: 'https://public.example/a', auth: 'Bearer x' },
			{ url: 'https://other.example/b', auth: null }
		]);
	});

	it.each([
		[303, 'POST', 'GET', null],
		[301, 'POST', 'GET', null],
		[302, 'POST', 'GET', null],
		[303, 'PUT', 'GET', null],
		[302, 'PUT', 'PUT', 'payload'],
		[307, 'POST', 'POST', 'payload'],
		[308, 'POST', 'POST', 'payload']
	])('on %i after %s re-issues as %s', async (status, method, nextMethod, nextBody) => {
		const seen: Array<{ method?: string; body: unknown; type: string | null }> = [];
		globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			seen.push({
				method: init?.method,
				body: init?.body ?? null,
				type: new Headers(init?.headers).get('content-type')
			});
			if (String(input) === 'https://public.example/a') {
				return new Response(null, { status, headers: { location: '/b' } });
			}
			return new Response('ok');
		}) as typeof fetch;

		const res = await safeFetch('https://public.example/a', {
			method,
			body: 'payload',
			headers: { 'content-type': 'text/plain' }
		});
		expect(await res.text()).toBe('ok');
		expect(seen[1]).toEqual({
			method: nextMethod,
			body: nextBody,
			type: nextBody ? 'text/plain' : null
		});
	});
});
