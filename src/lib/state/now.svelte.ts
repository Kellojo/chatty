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
	subscribe();
	return current;
}
