import { invalidateAll } from '$app/navigation';
import { toast } from 'svelte-sonner';

/** Mirrors the server's `AaKeyInfo` / `AaStatus` (server code can't be imported here). */
export interface AaState {
	key: { source: 'env' | 'app' | null; hint: string | null };
	status: {
		fetchedAt: number | null;
		indexVersion: number | null;
		lastError: string | null;
		retryAfter: number | null;
	};
}

const clockFormat = new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit' });
export const clockTime = (ms: number) => clockFormat.format(ms);

export async function aaRequest(method: string, path: string, body?: unknown) {
	const res = await fetch(path, {
		method,
		headers: body ? { 'content-type': 'application/json' } : undefined,
		body: body ? JSON.stringify(body) : undefined
	});
	const payload = await res.json().catch(() => null);
	if (!res.ok) throw new Error(payload?.message ?? `Request failed (${res.status})`);
	return payload;
}

/** Manual refresh with a toast for each outcome; the server still applies its cooldown. */
export async function refreshAaScores(): Promise<void> {
	try {
		const outcome = await aaRequest('POST', '/api/benchmarks/refresh');
		if (outcome.state === 'updated') toast.success('Scores updated');
		else if (outcome.state === 'failed') toast.error(outcome.status.lastError);
		else if (outcome.reason === 'cooldown') toast.info('Scores were refreshed moments ago');
		else if (outcome.reason === 'rate-limited')
			toast.error(`Rate limited until ${clockTime(outcome.status.retryAfter)}`);
		await invalidateAll();
	} catch (e) {
		toast.error(e instanceof Error ? e.message : 'Refresh failed');
	}
}

/** A reactive clock for "updated 3m ago" labels and cooldowns; ticks while `active()` is true. */
export function createClock(active: () => boolean = () => true, intervalMs = 15_000) {
	let now = $state(Date.now());
	$effect(() => {
		if (!active()) return;
		now = Date.now();
		const timer = setInterval(() => (now = Date.now()), intervalMs);
		return () => clearInterval(timer);
	});
	return {
		get now() {
			return now;
		}
	};
}
