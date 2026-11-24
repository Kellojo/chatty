import type { CodingModelOption } from '$lib/coding-environments.js';
import type { CodingOptions } from './coding-task.svelte.js';

// One request per environment for the page's lifetime; failures are retried next time.
const cache = new Map<string, Promise<CodingModelOption[]>>();

/** The models an environment offers, for showing a task's model by its name. */
export function loadCodingModels(environmentId: string): Promise<CodingModelOption[]> {
	let pending = cache.get(environmentId);
	if (!pending) {
		pending = fetch(`/api/coding/options?environmentId=${encodeURIComponent(environmentId)}`)
			.then(async (res) => {
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				return ((await res.json()) as CodingOptions).models;
			})
			.catch((e: unknown) => {
				cache.delete(environmentId);
				throw e;
			});
		cache.set(environmentId, pending);
	}
	return pending;
}
