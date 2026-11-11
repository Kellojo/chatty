// Web Push on this device: the server sends notices through the browser's push
// service, and the service worker shows them while Chatty is closed (see
// static/notification-sw.js and src/lib/server/push/).

export type PushSupport =
	| 'supported'
	/** iPhone/iPad Safari: push only exists in the Home Screen app. */
	| 'needs-install'
	/** Plain http (other than localhost): browsers only push to secure origins. */
	| 'insecure'
	| 'unsupported';

const SW_READY_TIMEOUT_MS = 4000;

function isIos(): boolean {
	const ua = navigator.userAgent;
	// iPadOS reports itself as a Mac; touch support gives it away.
	return /iPad|iPhone|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
}

function isStandalone(): boolean {
	return (
		window.matchMedia?.('(display-mode: standalone)').matches ||
		(navigator as Navigator & { standalone?: boolean }).standalone === true
	);
}

export function pushSupport(): PushSupport {
	if (typeof window === 'undefined') return 'unsupported';
	if (!window.isSecureContext) return 'insecure';
	if (isIos() && !isStandalone()) return 'needs-install';
	if (!('serviceWorker' in navigator) || !('PushManager' in window)) return 'unsupported';
	if (typeof Notification === 'undefined') return 'unsupported';
	return 'supported';
}

/** The active service worker registration, or null (dev mode, or not installed yet). */
async function registration(): Promise<ServiceWorkerRegistration | null> {
	if (!('serviceWorker' in navigator)) return null;
	// No worker registered at all (dev mode): don't wait on `ready`, it never settles.
	if (!(await navigator.serviceWorker.getRegistration().catch(() => undefined))) return null;
	const timeout = new Promise<null>((resolve) =>
		setTimeout(() => resolve(null), SW_READY_TIMEOUT_MS)
	);
	return Promise.race([navigator.serviceWorker.ready, timeout]).catch(() => null);
}

export async function currentPushSubscription(): Promise<PushSubscription | null> {
	if (pushSupport() !== 'supported') return null;
	const reg = await registration();
	return (await reg?.pushManager.getSubscription().catch(() => null)) ?? null;
}

export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
	const base64 = (value + '='.repeat((4 - (value.length % 4)) % 4))
		.replace(/-/g, '+')
		.replace(/_/g, '/');
	const raw = atob(base64);
	const bytes = new Uint8Array(new ArrayBuffer(raw.length));
	for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
	return bytes;
}

export function bytesToBase64Url(buffer: ArrayBuffer | null): string | null {
	if (!buffer) return null;
	let raw = '';
	for (const b of new Uint8Array(buffer)) raw += String.fromCharCode(b);
	return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function request(method: string, path: string, body?: unknown): Promise<Response> {
	const res = await fetch(path, {
		method,
		headers: body === undefined ? undefined : { 'content-type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	if (!res.ok) {
		const data = (await res.json().catch(() => null)) as { message?: string } | null;
		throw new PushRequestError(data?.message ?? `Request failed (${res.status})`, res.status);
	}
	return res;
}

class PushRequestError extends Error {
	constructor(
		message: string,
		readonly status: number
	) {
		super(message);
	}
}

/**
 * The account that turned push on in this browser. A device re-registers itself
 * on app start; this keeps it from moving to whoever signs in next.
 */
const OWNER_KEY = 'chatty.push.owner';

function storedOwner(): string | null {
	try {
		return localStorage.getItem(OWNER_KEY);
	} catch {
		return null;
	}
}

function storeOwner(userId: string | null): void {
	try {
		if (userId) localStorage.setItem(OWNER_KEY, userId);
		else localStorage.removeItem(OWNER_KEY);
	} catch {
		// storage unavailable: sync falls back to asking the server
	}
}

/** Registers the subscription with the server, as `owner` when re-registering on its own. */
async function register(sub: PushSubscription, owner?: string): Promise<void> {
	const res = await request('PUT', '/api/push/subscription', { ...sub.toJSON(), owner });
	storeOwner(((await res.json()) as { userId: string }).userId);
}

async function serverKey(): Promise<string> {
	const res = await request('GET', '/api/push');
	return ((await res.json()) as { publicKey: string }).publicKey;
}

/**
 * Subscribes this device and registers it with the server. Call from a click:
 * Safari only shows the permission prompt for a user gesture.
 */
export async function enablePush(): Promise<PushSubscription> {
	if (pushSupport() !== 'supported') throw new Error("This browser can't receive push here.");
	// Ask first, inside the gesture, before any await could end it.
	const permission = await Notification.requestPermission();
	if (permission !== 'granted') {
		throw new Error(
			permission === 'denied'
				? 'Notifications are blocked for this site. Allow them in your browser or system settings.'
				: 'Notification permission was not granted.'
		);
	}
	const reg = await registration();
	if (!reg) throw new Error('The app is still installing. Reload the page and try again.');
	const sub = await subscribeWithServerKey(reg);
	await register(sub);
	return sub;
}

/**
 * This device's subscription for the server's current key. One made with
 * another key (VAPID keys changed) can't receive our pushes: the push service
 * rejects every send. It is replaced.
 */
async function subscribeWithServerKey(reg: ServiceWorkerRegistration): Promise<PushSubscription> {
	const key = await serverKey();
	const existing = await reg.pushManager.getSubscription();
	if (existing && bytesToBase64Url(existing.options.applicationServerKey) === key) return existing;
	await existing?.unsubscribe().catch(() => undefined);
	return reg.pushManager.subscribe({
		userVisibleOnly: true,
		applicationServerKey: base64UrlToBytes(key)
	});
}

export async function disablePush(): Promise<void> {
	storeOwner(null);
	const sub = await currentPushSubscription();
	if (!sub) return;
	await request('DELETE', '/api/push/subscription', { endpoint: sub.endpoint }).catch(
		() => undefined
	);
	await sub.unsubscribe().catch(() => undefined);
}

/**
 * Re-registers this device's subscription on app start: the server may have
 * dropped it (pruned, session ended, database reset) or changed its keys. Only
 * for the account that turned push on here; if someone else is signed in now,
 * the device's push is turned off and they can opt in themselves.
 */
export async function syncPushSubscription(): Promise<boolean> {
	if (pushSupport() !== 'supported' || Notification.permission !== 'granted') return false;
	const reg = await registration();
	const existing = await reg?.pushManager.getSubscription().catch(() => null);
	if (!reg || !existing) return false;
	const owner = storedOwner();
	if (!owner) {
		// Nothing remembered (storage cleared, or turned on before this check): ask the server.
		const res = await request(
			'GET',
			`/api/push/subscription?endpoint=${encodeURIComponent(existing.endpoint)}`
		);
		if (((await res.json()) as { owner: string }).owner !== 'you') {
			await existing.unsubscribe().catch(() => undefined);
			return false;
		}
	}
	const sub = await subscribeWithServerKey(reg);
	try {
		await register(sub, owner ?? undefined);
	} catch (e) {
		if (e instanceof PushRequestError && e.status === 409) {
			storeOwner(null);
			await sub.unsubscribe().catch(() => undefined);
			return false;
		}
		throw e;
	}
	return true;
}

export async function sendTestPush(): Promise<void> {
	const sub = await currentPushSubscription();
	if (!sub) throw new Error('Push is off on this device.');
	await request('POST', '/api/push/test', { endpoint: sub.endpoint });
}
