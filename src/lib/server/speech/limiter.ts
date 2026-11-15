/** Speech requests running per key (a user, an API key), in this process. */
const running = new Map<string, number>();

/**
 * Takes one of `max` slots for `key`, or returns null when all are in use.
 * Call the returned function exactly once when the request finishes.
 */
export function acquireSpeechSlot(key: string, max: number): (() => void) | null {
	const count = running.get(key) ?? 0;
	if (count >= max) return null;
	running.set(key, count + 1);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		const left = (running.get(key) ?? 1) - 1;
		if (left > 0) running.set(key, left);
		else running.delete(key);
	};
}
