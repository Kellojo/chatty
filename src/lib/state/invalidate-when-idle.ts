import { invalidateAll } from '$app/navigation';
import { navigating } from '$app/state';

const POLL_MS = 50;
// A cancelled navigation leaves `navigating.to` set until the next one finishes,
// so it can't be trusted to clear and the wait has to be bounded.
const MAX_WAIT_MS = 10_000;

let waiting: Promise<void> | null = null;

/**
 * invalidateAll() for background refreshes (server events, read markers).
 * SvelteKit lets an invalidation cancel a navigation that is still loading, and
 * the goto() then resolves as if nothing went wrong, leaving the user on the old
 * page. So hold the refresh back until any in-flight navigation has finished.
 */
export function invalidateWhenIdle(): Promise<void> {
	if (!navigating.to) return invalidateAll();
	waiting ??= (async () => {
		const deadline = Date.now() + MAX_WAIT_MS;
		while (navigating.to && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, POLL_MS));
		}
		waiting = null;
		await invalidateAll();
	})();
	return waiting;
}
