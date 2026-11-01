import { SvelteSet } from 'svelte/reactivity';
import { invalidateWhenIdle } from '$lib/state/invalidate-when-idle.js';
import type { ServerEvent } from '$lib/types.js';

type Listener = (event: ServerEvent) => void;

const listeners = new SvelteSet<Listener>();
const resyncListeners = new SvelteSet<() => void>();
let source: EventSource | null = null;
let connectedOnce = false;

export function onServerEvent(listener: Listener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function onServerEventResync(listener: () => void): () => void {
	resyncListeners.add(listener);
	return () => {
		resyncListeners.delete(listener);
	};
}

export function startServerEvents(): () => void {
	if (source) return stopServerEvents;
	const events = new EventSource('/api/events');
	source = events;
	events.onopen = () => {
		if (source !== events) return;
		if (connectedOnce) {
			void invalidateWhenIdle();
			for (const listener of [...resyncListeners]) {
				try {
					listener();
				} catch (e) {
					console.error('Server event resync listener failed', e);
				}
			}
		}
		connectedOnce = true;
	};
	events.onmessage = (msg) => {
		if (source !== events) return;
		let event: ServerEvent;
		try {
			event = JSON.parse(msg.data) as ServerEvent;
		} catch {
			return;
		}
		for (const listener of [...listeners]) {
			try {
				listener(event);
			} catch (e) {
				console.error('Server event listener failed', e);
			}
		}
	};
	return stopServerEvents;
}

function stopServerEvents() {
	source?.close();
	source = null;
	connectedOnce = false;
}
