// Coordinates Chatty tabs so an event alerts once, not once per open tab.
//
// Every tab receives the same server events. One tab (the holder of a Web Lock)
// is the leader and the only one that shows desktop notifications and plays
// sounds. Tabs share their focus/visibility and path over a BroadcastChannel so
// the leader can stay quiet while you're looking at Chatty in another tab.
// Without Web Locks every tab acts as leader; notification tags still dedupe the
// desktop popups.

const CHANNEL = 'chatty-notifications';
const LOCK = 'chatty-notifications-leader';
const HEARTBEAT_MS = 10_000;
const STALE_MS = 30_000;

interface TabState {
	focused: boolean;
	visible: boolean;
	path: string;
	at: number;
}

type Message = { type: 'state'; id: string; state: TabState } | { type: 'bye'; id: string };

export interface TabCoordinator {
	isLeader(): boolean;
	/** Some Chatty tab has keyboard focus. */
	anyFocused(): boolean;
	/** Some Chatty tab is visible on this path. */
	anyVisibleOn(path: string): boolean;
	/** Re-announce this tab's state, e.g. after a client-side navigation. */
	refresh(): void;
	stop(): void;
}

export function startTabCoordinator(): TabCoordinator {
	const id = crypto.randomUUID();
	const peers = new Map<string, TabState>();
	const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL);
	let leader = !navigator.locks;
	let releaseLock: (() => void) | null = null;

	const own = (): TabState => ({
		focused: document.visibilityState === 'visible' && document.hasFocus(),
		visible: document.visibilityState === 'visible',
		path: location.pathname,
		at: Date.now()
	});

	const announce = () => channel?.postMessage({ type: 'state', id, state: own() } as Message);

	if (channel) {
		channel.onmessage = (e: MessageEvent<Message>) => {
			const msg = e.data;
			if (msg.type === 'bye') {
				peers.delete(msg.id);
				return;
			}
			const known = peers.has(msg.id);
			peers.set(msg.id, msg.state);
			// Answer newcomers so they learn about us without waiting a heartbeat.
			if (!known) announce();
		};
	}

	if (navigator.locks) {
		void navigator.locks
			.request(
				LOCK,
				() =>
					new Promise<void>((resolve) => {
						leader = true;
						releaseLock = resolve;
					})
			)
			.catch(() => {
				leader = true;
			});
	}

	const onChange = () => announce();
	const onHide = () => channel?.postMessage({ type: 'bye', id } as Message);
	document.addEventListener('visibilitychange', onChange);
	window.addEventListener('focus', onChange);
	window.addEventListener('blur', onChange);
	window.addEventListener('pagehide', onHide);
	window.addEventListener('pageshow', onChange);
	const heartbeat = setInterval(announce, HEARTBEAT_MS);
	announce();

	const states = (): TabState[] => {
		const now = Date.now();
		for (const [peerId, state] of peers) {
			if (now - state.at > STALE_MS) peers.delete(peerId);
		}
		return [own(), ...peers.values()];
	};

	return {
		isLeader: () => leader,
		anyFocused: () => states().some((s) => s.focused),
		anyVisibleOn: (path) => states().some((s) => s.visible && s.path === path),
		refresh: announce,
		stop() {
			clearInterval(heartbeat);
			document.removeEventListener('visibilitychange', onChange);
			window.removeEventListener('focus', onChange);
			window.removeEventListener('blur', onChange);
			window.removeEventListener('pagehide', onHide);
			window.removeEventListener('pageshow', onChange);
			onHide();
			channel?.close();
			releaseLock?.();
			leader = false;
		}
	};
}
