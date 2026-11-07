// Imported into the generated service worker (workbox `importScripts` in
// vite.config.ts). Clicking a notification focuses an open Chatty window and asks
// it to navigate client-side, or opens a new window when none is open.
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
