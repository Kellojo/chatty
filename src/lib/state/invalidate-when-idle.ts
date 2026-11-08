import { invalidate, invalidateAll } from '$app/navigation';
import { navigating } from '$app/state';

const POLL_MS = 50;
// A cancelled navigation leaves `navigating.to` set until the next one finishes,
// so it can't be trusted to clear and the wait has to be bounded.
const MAX_WAIT_MS = 10_000;

let waiting: Promise<void> | null = null;
let pendingAll = false;
const pendingKeys = new Set<string>();

function flush(): Promise<void> {
	const all = pendingAll;
	const keys = [...pendingKeys];
	pendingAll = false;
	pendingKeys.clear();
	if (all) return invalidateAll();
	return Promise.all(keys.map((key) => invalidate(key))).then(() => undefined);
}

/**
 * invalidateAll() — or invalidate(key) for just the loads depending on `key` —
 * for background refreshes (server events, read markers). SvelteKit lets an
 * invalidation cancel a navigation that is still loading, and the goto() then
 * resolves as if nothing went wrong, leaving the user on the old page. So hold
 * the refresh back until any in-flight navigation has finished.
 */
export function invalidateWhenIdle(key?: string): Promise<void> {
	if (key === undefined) pendingAll = true;
	else pendingKeys.add(key);
	if (!navigating.to && !waiting) return flush();
	waiting ??= (async () => {
		const deadline = Date.now() + MAX_WAIT_MS;
		while (navigating.to && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, POLL_MS));
		}
		waiting = null;
		await flush();
	})();
	return waiting;
}
