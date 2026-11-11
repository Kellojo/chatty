// Runs static/notification-sw.js against a fake service worker scope: the file
// is plain JS imported into the generated worker, so nothing else covers it.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

type Listener = (event: Record<string, unknown>) => void;

async function loadWorker(existing: { data?: unknown }[] = []) {
	const source = await readFile(path.resolve('static/notification-sw.js'), 'utf8');
	const listeners = new Map<string, Listener>();
	const showNotification = vi.fn(async () => undefined);
	const client = {
		focused: true,
		visibilityState: 'visible',
		focus: vi.fn(async () => undefined),
		postMessage: vi.fn()
	};
	const self = {
		location: { origin: 'https://chatty.example.ts.net' },
		addEventListener: (type: string, fn: Listener) => listeners.set(type, fn),
		registration: {
			showNotification,
			getNotifications: async () => existing,
			pushManager: { subscribe: vi.fn() }
		},
		clients: { matchAll: async () => [client], openWindow: vi.fn() }
	};
	runInNewContext(source, { self, URL, fetch: vi.fn(), Date });
	/** Fires an event and waits for what it handed to waitUntil. */
	const fire = async (type: string, event: Record<string, unknown>) => {
		let pending: Promise<unknown> = Promise.resolve();
		listeners.get(type)?.({ ...event, waitUntil: (p: Promise<unknown>) => (pending = p) });
		await pending;
	};
	return { listeners, showNotification, client, fire };
}

const pushEvent = (data: unknown) => ({ data: { json: () => data, text: () => '' } });

describe('notification service worker', () => {
	it('handles pushes, clicks and subscription rotation', async () => {
		const { listeners } = await loadWorker();
		expect([...listeners.keys()].sort()).toEqual([
			'notificationclick',
			'push',
			'pushsubscriptionchange'
		]);
	});

	it('shows a pushed notice and alerts for it', async () => {
		const { fire, showNotification } = await loadWorker();
		await fire(
			'push',
			pushEvent({ title: 'Agent', body: 'Needs you', tag: 'chat:1', url: '/chat/1' })
		);
		expect(showNotification).toHaveBeenCalledWith(
			'Agent',
			expect.objectContaining({
				body: 'Needs you',
				tag: 'chat:1',
				renotify: true,
				data: { url: '/chat/1' }
			})
		);
	});

	it('quietly replaces the same notice an open tab just showed', async () => {
		const { fire, showNotification } = await loadWorker([{ data: { shownAt: Date.now() } }]);
		await fire(
			'push',
			pushEvent({ title: 'Chat', body: 'New reply', tag: 'chat:1', url: '/chat/1' })
		);
		expect(showNotification).toHaveBeenCalledWith(
			'Chat',
			expect.objectContaining({ renotify: false })
		);
	});

	it('never links off-site', async () => {
		const { fire, showNotification } = await loadWorker();
		await fire('push', pushEvent({ title: 'x', url: 'https://evil.example/' }));
		expect(showNotification).toHaveBeenCalledWith(
			'x',
			expect.objectContaining({ data: { url: '/' } })
		);
	});

	it('opens the chat when a notification is clicked', async () => {
		const { fire, client } = await loadWorker();
		const close = vi.fn();
		await fire('notificationclick', { notification: { close, data: { url: '/chat/1' } } });
		expect(close).toHaveBeenCalled();
		expect(client.focus).toHaveBeenCalled();
		expect(client.postMessage).toHaveBeenCalledWith({ type: 'chatty:navigate', url: '/chat/1' });
	});
});
