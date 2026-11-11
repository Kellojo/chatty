import { afterEach, describe, expect, it, vi } from 'vitest';
import { base64UrlToBytes, bytesToBase64Url, pushSupport } from './push.js';

const IPHONE =
	'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IPAD_AS_MAC =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const ANDROID =
	'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36';

function stubBrowser(opts: {
	userAgent: string;
	standalone?: boolean;
	secure?: boolean;
	touchPoints?: number;
	push?: boolean;
}) {
	vi.stubGlobal('window', {
		isSecureContext: opts.secure ?? true,
		matchMedia: () => ({ matches: opts.standalone ?? false }),
		...(opts.push === false ? {} : { PushManager: class {} })
	});
	vi.stubGlobal('navigator', {
		userAgent: opts.userAgent,
		maxTouchPoints: opts.touchPoints ?? 0,
		serviceWorker: {}
	});
	vi.stubGlobal('Notification', { permission: 'default' });
}

afterEach(() => vi.unstubAllGlobals());

describe('pushSupport', () => {
	it('is supported on Android Chrome', () => {
		stubBrowser({ userAgent: ANDROID });
		expect(pushSupport()).toBe('supported');
	});

	it('asks iPhone Safari to install the app first', () => {
		stubBrowser({ userAgent: IPHONE });
		expect(pushSupport()).toBe('needs-install');
		stubBrowser({ userAgent: IPHONE, standalone: true });
		expect(pushSupport()).toBe('supported');
	});

	it('recognises an iPad that reports itself as a Mac', () => {
		stubBrowser({ userAgent: IPAD_AS_MAC, touchPoints: 5 });
		expect(pushSupport()).toBe('needs-install');
		// A real Mac (no touch) uses Safari's regular web push.
		stubBrowser({ userAgent: IPAD_AS_MAC, touchPoints: 0 });
		expect(pushSupport()).toBe('supported');
	});

	it('needs a secure origin and the Push API', () => {
		stubBrowser({ userAgent: ANDROID, secure: false });
		expect(pushSupport()).toBe('insecure');
		stubBrowser({ userAgent: ANDROID, push: false });
		expect(pushSupport()).toBe('unsupported');
	});
});

describe('base64url key encoding', () => {
	it('round-trips a VAPID public key', () => {
		const key =
			'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM';
		const bytes = base64UrlToBytes(key);
		expect(bytes).toHaveLength(65);
		expect(bytesToBase64Url(bytes.buffer)).toBe(key);
	});

	it('treats a missing key as no match', () => {
		expect(bytesToBase64Url(null)).toBeNull();
	});
});
