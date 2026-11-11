// Tells the server what this tab shows and how long ago you last touched it,
// so push notices wait while you're at Chatty and skip chats you've already
// seen (src/lib/server/push/presence.ts). Reported on changes, on a heartbeat
// while visible, and every few seconds while you type or click.

/** Heartbeat while visible; well under the server's 60 s expiry. */
const HEARTBEAT_MS = 20_000;
/** While you're touching the tab, refresh the server's "last input" at most this often. */
const INPUT_REPORT_MS = 5_000;

const ENDPOINT = '/api/push/presence';

// Only things a person does. Not `scroll`: the chat scrolls itself while a reply
// streams, which would count an empty desk as you being there.
export const INPUT_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

/** The path to report: what the tab shows, or null while it is hidden. */
export function reportedPath(visible: boolean, pathname: string): string | null {
	return visible ? pathname : null;
}

export interface PresenceReporter {
	/** Re-report right away, e.g. after a client-side navigation. */
	refresh(): void;
	stop(): void;
}

export function startPresenceReporter(): PresenceReporter {
	const clientId = crypto.randomUUID();
	let lastInputAt = Date.now();
	/** Path of the last report; undefined before the first. */
	let reported: string | null | undefined;
	let lastSentAt = 0;

	const send = (path: string | null, beacon = false) => {
		reported = path;
		lastSentAt = Date.now();
		const body = JSON.stringify({ clientId, path, idleMs: Math.max(0, lastSentAt - lastInputAt) });
		if (beacon && navigator.sendBeacon?.(ENDPOINT, body)) return;
		void fetch(ENDPOINT, { method: 'POST', body, keepalive: true }).catch(() => undefined);
	};

	/** Sends on a change, for the heartbeat, or when `fresh` asks for an up-to-date report. */
	const report = (fresh: boolean) => {
		const path = reportedPath(document.visibilityState === 'visible', location.pathname);
		const due = path !== null && Date.now() - lastSentAt >= HEARTBEAT_MS;
		if (path !== reported || due || fresh) send(path);
	};
	const evaluate = () => report(false);

	const onInput = () => {
		lastInputAt = Date.now();
		// Keep the server's "last touched" fresh, so it knows you came back to a chat.
		report(lastInputAt - lastSentAt >= INPUT_REPORT_MS);
	};
	const onHide = () => {
		if (reported !== null) send(null, true);
	};

	for (const type of INPUT_EVENTS) {
		window.addEventListener(type, onInput, { passive: true, capture: true });
	}
	document.addEventListener('visibilitychange', evaluate);
	window.addEventListener('pagehide', onHide);
	const timer = setInterval(evaluate, HEARTBEAT_MS / 2);
	evaluate();

	return {
		refresh: evaluate,
		stop() {
			clearInterval(timer);
			for (const type of INPUT_EVENTS) {
				window.removeEventListener(type, onInput, { capture: true });
			}
			document.removeEventListener('visibilitychange', evaluate);
			window.removeEventListener('pagehide', onHide);
			onHide();
		}
	};
}
