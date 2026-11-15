import { describe, expect, it } from 'vitest';
import { relayUpstreamError } from './targets.js';

describe('relayUpstreamError', () => {
	it('turns the provider refusing Chatty’s key into a 502', () => {
		expect(relayUpstreamError(401, 'bad key')).toEqual({
			status: 502,
			message: 'Provider rejected the request: bad key'
		});
		expect(relayUpstreamError(403, 'nope').status).toBe(502);
	});

	it('keeps other error statuses and replaces non-error ones', () => {
		expect(relayUpstreamError(429, 'slow down')).toEqual({ status: 429, message: 'slow down' });
		expect(relayUpstreamError(400, 'bad voice').status).toBe(400);
		expect(relayUpstreamError(200, 'odd').status).toBe(502);
	});
});
