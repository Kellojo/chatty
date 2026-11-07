import { afterEach, describe, expect, it, vi } from 'vitest';
import { T3ClientError, exchangePairingToken } from './client.js';

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
			'orchestration:read orchestration:operate diagnostics:read source-control:write'
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
