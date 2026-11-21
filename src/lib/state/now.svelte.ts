// A shared once-a-second clock for live durations. It only ticks while some
// reactive context reads it, so idle pages don't keep a timer running.

import { createSubscriber } from 'svelte/reactivity';

let current = Date.now();

const subscribe = createSubscriber((update) => {
	current = Date.now();
	const timer = setInterval(() => {
		current = Date.now();
		update();
	}, 1000);
	return () => clearInterval(timer);
});

/** Current time in ms; re-runs the reading effect/derived every second. */
export function now(): number {
	// Server rendering never subscribes, so `current` would be stuck at when the
	// module loaded: a live timer would render "0s" there and something else once
	// the page hydrates, and that mismatch makes Svelte throw away the server HTML
	// and remount the whole page (losing anything typed before hydration).
	if (typeof window === 'undefined') return Date.now();
	subscribe();
	return current;
}
