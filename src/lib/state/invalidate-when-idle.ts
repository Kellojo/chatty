import { invalidate, invalidateAll } from '$app/navigation';
import { navigating } from '$app/state';

const POLL_MS = 50;
// A cancelled navigation leaves `navigating.to` set until the next one finishes,
// so it can't be trusted to clear and the wait has to be bounded.
const MAX_WAIT_MS = 10_000;
/**
 * How long after the pointer reached a link a refresh holds back. Links preload
 * their page on hover, and any invalidation throws that preload away; this
 * gives the click (and so the navigation, which is waited for) time to follow.
 */
const HOVER_GRACE_MS = 1_000;
/** Moving across a list of links keeps hovering; past this the refresh goes ahead anyway. */
const HOVER_MAX_WAIT_MS = 2_000;
/** How long scheduleInvalidate() collects requests before running them together. */
const BATCH_MS = 200;

let waiting: Promise<void> | null = null;
let pendingAll = false;
const pendingKeys = new Set<string>();

let lastLinkHover = 0;
if (typeof document !== 'undefined') {
	document.addEventListener(
		'pointerover',
		(event) => {
			if (event.target instanceof Element && event.target.closest('a[href]')) {
				lastLinkHover = Date.now();
			}
		},
		{ capture: true, passive: true }
	);
}

/** Whether to hold back a refresh that has been waiting since `since`. */
function busy(since: number): boolean {
	const now = Date.now();
	if (navigating.to) return now - since < MAX_WAIT_MS;
	return now - lastLinkHover < HOVER_GRACE_MS && now - since < HOVER_MAX_WAIT_MS;
}

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
 * the refresh back until any in-flight navigation has finished, and briefly
 * after the pointer reached a link (whose hover preload it would discard).
 */
export function invalidateWhenIdle(key?: string): Promise<void> {
	if (key === undefined) pendingAll = true;
	else pendingKeys.add(key);
	return runWhenIdle();
}

function runWhenIdle(): Promise<void> {
	if (!waiting && !busy(Date.now())) return flush();
	waiting ??= (async () => {
		const since = Date.now();
		while (busy(since)) {
			await new Promise((r) => setTimeout(r, POLL_MS));
		}
		waiting = null;
		await flush();
	})();
	return waiting;
}

let batch: Promise<void> | null = null;
let batchAll = false;
const batchKeys = new Set<string>();

/**
 * invalidateWhenIdle() for refreshes that may come in bursts: every request
 * within BATCH_MS of the first one runs as a single invalidation. Server events
 * and read markers about the same change then reload the sidebar only once.
 */
export function scheduleInvalidate(key?: string): Promise<void> {
	if (key === undefined) batchAll = true;
	else batchKeys.add(key);
	batch ??= new Promise((resolve) => {
		setTimeout(() => {
			const all = batchAll;
			const keys = [...batchKeys];
			batch = null;
			batchAll = false;
			batchKeys.clear();
			if (all) pendingAll = true;
			for (const k of keys) pendingKeys.add(k);
			resolve(runWhenIdle());
		}, BATCH_MS);
	});
	return batch;
}
