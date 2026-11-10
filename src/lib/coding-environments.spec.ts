import { describe, expect, it } from 'vitest';
import {
	acceptsTypedAnswer,
	parseEnvironmentUrl,
	repositoryName,
	type CodingPendingRequest
} from './coding-environments.js';

describe('parseEnvironmentUrl', () => {
	it('splits a pairing link into base URL and token', () => {
		expect(parseEnvironmentUrl('http://devbox:3773/pair#token=123456567hfglh')).toEqual({
			baseUrl: 'http://devbox:3773',
			pairingToken: '123456567hfglh'
		});
	});

	it('keeps a reverse-proxy path prefix', () => {
		expect(parseEnvironmentUrl(' https://host.example/t3/pair/#token=abc ')).toEqual({
			baseUrl: 'https://host.example/t3',
			pairingToken: 'abc'
		});
	});

	it('accepts the token as a query parameter too', () => {
		expect(parseEnvironmentUrl('https://host.example/pair?token=abc')?.pairingToken).toBe('abc');
	});

	it('returns plain base URLs without a token', () => {
		expect(parseEnvironmentUrl('https://devbox.tailnet.ts.net/')).toEqual({
			baseUrl: 'https://devbox.tailnet.ts.net',
			pairingToken: null
		});
	});

	it('rejects non-http input', () => {
		expect(parseEnvironmentUrl('not a url')).toBeNull();
		expect(parseEnvironmentUrl('ftp://host/pair#token=x')).toBeNull();
	});
});

describe('repositoryName', () => {
	it('reads GitHub shorthand, HTTPS and SSH URLs', () => {
		expect(repositoryName('Kellojo/ai-chat')).toBe('ai-chat');
		expect(repositoryName('https://github.com/Kellojo/ai-chat.git')).toBe('ai-chat');
		expect(repositoryName('https://github.com/Kellojo/ai-chat/')).toBe('ai-chat');
		expect(repositoryName('git@github.com:Kellojo/ai-chat.git')).toBe('ai-chat');
		expect(repositoryName('ai-chat')).toBe('ai-chat');
	});

	it('rejects input without a usable name', () => {
		expect(repositoryName('')).toBeNull();
		expect(repositoryName('https://github.com/')).toBeNull();
		expect(repositoryName('owner/..')).toBeNull();
		expect(repositoryName('owner/bad name')).toBeNull();
	});
});

const request = (patch: Partial<CodingPendingRequest>): CodingPendingRequest => ({
	requestId: 'r1',
	kind: 'question',
	title: 'Which one?',
	detail: null,
	options: [],
	allowFreeText: true,
	createdAt: 0,
	...patch
});

describe('acceptsTypedAnswer', () => {
	it('takes a typed answer to a question that allows free text', () => {
		expect(acceptsTypedAnswer(request({}))).toBe(true);
		expect(acceptsTypedAnswer(request({ allowFreeText: false }))).toBe(false);
	});

	it('takes typed text on an approval only when it can decline', () => {
		const accept = { id: 'accept', label: 'Approve' };
		expect(
			acceptsTypedAnswer(
				request({ kind: 'approval', options: [accept, { id: 'decline', label: 'Decline' }] })
			)
		).toBe(true);
		expect(
			acceptsTypedAnswer(
				request({
					kind: 'approval',
					options: [accept, { id: 'acceptForSession', label: 'Approve for session' }]
				})
			)
		).toBe(false);
	});
});
