import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	T3ClientError,
	exchangePairingToken,
	fetchEnvironmentDescriptor,
	t3FetchBinary,
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
			'orchestration:read orchestration:operate diagnostics:read source-control:write filesystem:read preview:operate'
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

	it('reports a non-JSON 200 (e.g. a proxy page) as incompatible', async () => {
		for (const body of ['<html>Login</html>', '']) {
			vi.stubGlobal(
				'fetch',
				vi.fn(async () => new Response(body, { status: 200 }))
			);
			const result = t3HttpGet('http://devbox:3773', 't', '/api/projects');
			await expect(result).rejects.toBeInstanceOf(T3ClientError);
			await expect(result).rejects.toMatchObject({ kind: 'incompatible' });
		}
	});

	it('wraps a failure while reading the body', async () => {
		const failing = (error: Error) =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode('{"a":'));
						controller.error(error);
					}
				}),
				{ status: 200 }
			);
		const timeout = new DOMException('The operation timed out', 'TimeoutError');
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => failing(timeout))
		);
		await expect(t3HttpGet('http://devbox:3773', 't', '/api/x')).rejects.toMatchObject({
			name: 'T3ClientError',
			kind: 'unreachable',
			message: expect.stringMatching(/timed out/)
		});

		vi.stubGlobal(
			'fetch',
			vi.fn(async () => failing(new TypeError('terminated')))
		);
		await expect(
			t3FetchBinary('http://devbox:3773', 't', '/api/assets/a.png', 1024)
		).rejects.toMatchObject({ name: 'T3ClientError', kind: 'unreachable' });
	});

	it('gives binary downloads a longer timeout than JSON calls', async () => {
		const timeout = vi.spyOn(AbortSignal, 'timeout');
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('png', { headers: { 'content-type': 'image/png' } }))
		);
		await t3FetchBinary('http://devbox:3773', 't', '/api/assets/a.png', 1024);
		expect(timeout).toHaveBeenLastCalledWith(60_000);
		timeout.mockRestore();
	});
});

describe('T3Connection silence watchdog', () => {
	class FakeSocket extends EventTarget {
		readonly sent: unknown[] = [];
		closed = false;
		send(data: string) {
			this.sent.push(JSON.parse(data));
		}
		close() {
			this.closed = true;
		}
	}

	it('fails a socket that stops answering pings, but not one that keeps talking', async () => {
		vi.useFakeTimers();
		try {
			const { T3Connection, SILENCE_TIMEOUT_MS } = await import('./client.js');
			const quiet = new FakeSocket();
			const chatty = new FakeSocket();
			const quietConn = new T3Connection(quiet as unknown as WebSocket);
			const chattyConn = new T3Connection(chatty as unknown as WebSocket);
			const onClose = vi.fn();
			quietConn.onClose(onClose);

			for (let t = 0; t < SILENCE_TIMEOUT_MS + 15_000; t += 5_000) {
				chatty.dispatchEvent(new MessageEvent('message', { data: '{"_tag":"Pong"}' }));
				await vi.advanceTimersByTimeAsync(5_000);
			}

			expect(quietConn.closed).toBe(true);
			expect(quiet.closed).toBe(true);
			expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ kind: 'unreachable' }));
			expect(chattyConn.closed).toBe(false);
			chattyConn.close();
		} finally {
			vi.useRealTimers();
		}
	});
});
