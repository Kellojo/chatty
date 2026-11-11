// The browser hands us a push endpoint URL and the server POSTs to it. Only
// known push services are accepted, so a signed-in user can't point the server
// at arbitrary hosts (internal services on the tailnet, metadata endpoints).

/** Push services of the major browsers; a host matches itself or a subdomain. */
export const PUSH_SERVICE_HOSTS = [
	// Chrome, Edge on Android, Samsung Internet, Opera, Brave
	'fcm.googleapis.com',
	'android.googleapis.com',
	// Firefox
	'push.services.mozilla.com',
	// Safari on macOS, iOS and iPadOS
	'push.apple.com',
	// Edge on Windows
	'notify.windows.com'
] as const;

export function isPushServiceEndpoint(value: string): boolean {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
	const host = url.hostname.toLowerCase();
	return PUSH_SERVICE_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}
