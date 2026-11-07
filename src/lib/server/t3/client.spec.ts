import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	T3ClientError,
	exchangePairingToken,
	fetchEnvironmentDescriptor,
	t3HttpGet
} from './client.js';

afterEach(() => vi.unstubAllGlobals());

describe('exchangePairingToken', () => {
	it('exchanges the pairing code for a read-only bearer token', async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({ access_token: 'session-token', token_type: 'Bearer', expires_in: 3600 })
		);
		vi.stubGlobal('fetch', fetchMock);

		await expect(exchangePairingToken('http://devbox:3773', 'pair-code')).resolves.toBe(
			'session-token'
		);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('http://devbox:3773/oauth/token');
		expect(init.method).toBe('POST');
		const body = init.body as URLSearchParams;
		expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:token-exchange');
		expect(body.get('subject_token')).toBe('pair-code');
		expect(body.get('subject_token_type')).toBe(
			'urn:t3:params:oauth:token-type:environment-bootstrap'
		);
		expect(body.get('scope')).toBe(
			'orchestration:read orchestration:operate diagnostics:read source-control:write workspace'
		);
	});

	it('reports used or expired pairing links clearly', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('{}', { status: 401 }))
		);
		const result = exchangePairingToken('http://devbox:3773', 'used');
		await expect(result).rejects.toBeInstanceOf(T3ClientError);
		await expect(result).rejects.toThrow(/expired or already been used/);
	});
});

describe('untrusted server responses', () => {
	it('refuses link-local / metadata addresses without sending a request', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		for (const base of ['http://169.254.169.254', 'http://[fe80::1]:3773', 'http://0.0.0.0:80']) {
			await expect(fetchEnvironmentDescriptor(base)).rejects.toBeInstanceOf(T3ClientError);
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('rejects oversized JSON bodies', async () => {
		const big = 'x'.repeat(17 * 1024 * 1024);
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(JSON.stringify({ big }), { status: 200 }))
		);
		await expect(t3HttpGet('http://devbox:3773', 't', '/api/projects')).rejects.toThrow(
			/too large/
		);
	});
});
