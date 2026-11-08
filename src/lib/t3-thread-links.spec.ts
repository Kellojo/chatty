import { describe, expect, it } from 'vitest';
import { parseT3ThreadLink, parseT3ThreadPath, t3ThreadLinkToPath } from './t3-thread-links.js';

const ENV = '7e3851c2-6cdb-4b48-b71a-914be7348099';
const THREAD = '7681b5c9-4dfa-401a-b927-c9848bba69b5';

describe('t3 thread links', () => {
	it('parses a v2 thread link', () => {
		expect(parseT3ThreadLink(`t3-thread://v2/${ENV}/${THREAD}`)).toEqual({
			environmentId: ENV,
			threadId: THREAD
		});
	});

	it('maps a link to a Chatty path and back', () => {
		const path = t3ThreadLinkToPath(`t3-thread://v2/${ENV}/${THREAD}`);
		expect(path).toBe(`/t3-thread/${ENV}/${THREAD}`);
		expect(parseT3ThreadPath(path!)).toEqual({ environmentId: ENV, threadId: THREAD });
	});

	it('rejects other links', () => {
		expect(t3ThreadLinkToPath('https://example.com')).toBeNull();
		expect(t3ThreadLinkToPath(`t3-thread://v1/${ENV}/${THREAD}`)).toBeNull();
		expect(t3ThreadLinkToPath(`t3-thread://v2/${ENV}`)).toBeNull();
		expect(t3ThreadLinkToPath(`t3-thread://v2/${ENV}/../x`)).toBeNull();
		expect(parseT3ThreadPath('/chat/abc')).toBeNull();
	});
});
