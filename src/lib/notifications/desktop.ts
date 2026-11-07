// Desktop notifications. They go through the service worker when one is active,
// which is required on Android and lets a click focus or open Chatty even after
// the tab that raised it is gone (see static/notification-sw.js). Without a
// worker (dev, or before it activates) they fall back to `new Notification`.
import type { Notice } from './rules.js';

/** Message the service worker posts to a tab when a notification is clicked. */
export const NAVIGATE_MESSAGE = 'chatty:navigate';

export type DesktopPermission = NotificationPermission | 'unsupported';

export function desktopPermission(): DesktopPermission {
	return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

export async function requestDesktopPermission(): Promise<DesktopPermission> {
	if (typeof Notification === 'undefined') return 'unsupported';
	if (Notification.permission !== 'default') return Notification.permission;
	try {
		return await Notification.requestPermission();
	} catch {
		return Notification.permission;
	}
}

export async function showDesktopNotice(
	notice: Pick<Notice, 'title' | 'body' | 'tag' | 'url'>,
	onClick: (url: string) => void
): Promise<void> {
	if (desktopPermission() !== 'granted') return;
	const options: NotificationOptions = {
		body: notice.body,
		tag: notice.tag,
		icon: '/pwa-192x192.png',
		badge: '/pwa-192x192.png',
		data: { url: notice.url }
	};
	const registration = await navigator.serviceWorker?.getRegistration().catch(() => undefined);
	if (registration?.active) {
		await registration.showNotification(notice.title, options);
		return;
	}
	const notification = new Notification(notice.title, options);
	notification.onclick = () => {
		window.focus();
		notification.close();
		onClick(notice.url);
	};
}

/** Follows notification clicks the service worker forwards to this tab. */
export function listenForNotificationClicks(onClick: (url: string) => void): () => void {
	const container = navigator.serviceWorker;
	if (!container) return () => {};
	const handler = (e: MessageEvent) => {
		const data = e.data as { type?: string; url?: string } | null;
		if (data?.type === NAVIGATE_MESSAGE && typeof data.url === 'string') onClick(data.url);
	};
	container.addEventListener('message', handler);
	return () => container.removeEventListener('message', handler);
}
