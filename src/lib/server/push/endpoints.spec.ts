import { describe, expect, it } from 'vitest';
import { isPushServiceEndpoint } from './endpoints.js';

describe('isPushServiceEndpoint', () => {
	it('accepts the push services of the major browsers', () => {
		for (const url of [
			'https://fcm.googleapis.com/fcm/send/abc:def',
			'https://updates.push.services.mozilla.com/wpush/v2/abc',
			'https://web.push.apple.com/QGx1Y2t5',
			'https://wns2-db5p.notify.windows.com/w/?token=abc'
		]) {
			expect(isPushServiceEndpoint(url), url).toBe(true);
		}
	});

	it('rejects other hosts, look-alikes, plain http and odd URLs', () => {
		for (const url of [
			'https://example.com/push',
			'https://100.64.0.1/',
			'https://localhost/',
			'https://fcm.googleapis.com.evil.example/x',
			'https://evilpush.apple.com/x',
			'http://fcm.googleapis.com/fcm/send/abc',
			'https://user:pw@fcm.googleapis.com/fcm/send/abc',
			'https://fcm.googleapis.com:8443/fcm/send/abc',
			'not a url'
		]) {
			expect(isPushServiceEndpoint(url), url).toBe(false);
		}
	});
});
