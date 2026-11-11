// Imported into the generated service worker (workbox `importScripts` in
// vite.config.ts). Shows Web Push notices sent by the server (see
// src/lib/server/push/), and handles clicks: focus an open Chatty window and ask
// it to navigate client-side, or open a new window when none is open.

// Every push must show a notification: iOS revokes subscriptions that receive
// pushes without one, so there is no "skip it, a tab is open" branch here. The
// server holds pushes back instead while you're using Chatty.
self.addEventListener('push', (event) => {
	let data;
	try {
		data = event.data ? event.data.json() : {};
	} catch {
		data = { body: event.data ? event.data.text() : '' };
	}
	const title = typeof data.title === 'string' && data.title ? data.title : 'Chatty';
	const url = typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/';
	const tag = typeof data.tag === 'string' && data.tag ? data.tag : undefined;
	event.waitUntil(
		(async () => {
			// An open tab may have shown this same notice itself (any time since it
			// arose; pushes can be held a while): replace it without alerting twice.
			// An older one for the same chat alerts again.
			const createdAt = typeof data.createdAt === 'number' ? data.createdAt : Date.now();
			const existing = tag ? await self.registration.getNotifications({ tag }) : [];
			const alreadyShown = existing.some(
				(n) => n.data && typeof n.data.shownAt === 'number' && n.data.shownAt >= createdAt - 5000
			);
			await self.registration.showNotification(title, {
				body: typeof data.body === 'string' ? data.body : '',
				tag,
				renotify: !!tag && !alreadyShown,
				icon: '/pwa-192x192.png',
				badge: '/pwa-192x192.png',
				data: { url }
			});
		})()
	);
});

// Clicking a notification (pushed, or shown by an open tab) opens its chat.
self.addEventListener('notificationclick', (event) => {
	event.notification.close();
	const path = (event.notification.data && event.notification.data.url) || '/';
	const url = new URL(path, self.location.origin);
	if (url.origin !== self.location.origin) return;
	event.waitUntil(
		(async () => {
			const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
			const client =
				windows.find((c) => c.focused) ||
				windows.find((c) => c.visibilityState === 'visible') ||
				windows[0];
			if (client) {
				await client.focus();
				client.postMessage({ type: 'chatty:navigate', url: url.pathname + url.search });
				return;
			}
			await self.clients.openWindow(url.href);
		})()
	);
});

// The browser rotated the subscription (expiry, key change). Re-subscribe with
// the same server key and hand the server the new one in place of the old, so
// pushes keep arriving. The server only accepts that from the account holding
// the old one. Without the old subscription there is nothing to vouch for the
// swap; the app re-registers itself the next time it opens.
self.addEventListener('pushsubscriptionchange', (event) => {
	const old = event.oldSubscription;
	if (!old) return;
	event.waitUntil(
		(async () => {
			const key = old.options ? old.options.applicationServerKey : null;
			const next =
				event.newSubscription ||
				(key
					? await self.registration.pushManager
							.subscribe({ userVisibleOnly: true, applicationServerKey: key })
							.catch(() => null)
					: null);
			if (!next) return;
			await fetch('/api/push/subscription', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify({ ...next.toJSON(), replaces: old.endpoint })
			}).catch(() => undefined);
		})()
	);
});
