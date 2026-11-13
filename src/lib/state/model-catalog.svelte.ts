import { untrack } from 'svelte';
import type { ModelCatalogInfo, PickerModelGroup } from '$lib/types.js';

/**
 * The model pickers' list of enabled models, kept for the whole session.
 *
 * Page loads report only the catalog's version (plus the list itself on a full
 * page load), so switching chats and background refreshes don't re-send
 * hundreds of models. A changed version (models edited in settings, which
 * reruns the loads) fetches the new list once.
 */
let cache = $state.raw<{ version: string; groups: PickerModelGroup[] } | null>(null);
let inflight: string | null = null;

/**
 * Brings the cache up to `info`'s version. Browser only: call from an effect,
 * which then reruns only for a new `info`.
 */
export function syncModelCatalog(info: ModelCatalogInfo): void {
	untrack(() => sync(info));
}

function sync(info: ModelCatalogInfo): void {
	if (cache?.version === info.version) return;
	if (info.groups) {
		cache = { version: info.version, groups: info.groups };
		return;
	}
	if (inflight === info.version) return;
	inflight = info.version;
	void fetchCatalog(info.version);
}

async function fetchCatalog(version: string): Promise<void> {
	try {
		const res = await fetch(`/api/models/catalog?v=${encodeURIComponent(version)}`);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = (await res.json()) as { version: string; groups: PickerModelGroup[] };
		// A newer version was asked for meanwhile; that request will set it.
		if (inflight !== version) return;
		cache = { version: data.version, groups: data.groups };
	} catch {
		// Kept as is; the next sync for this version tries again.
	} finally {
		if (inflight === version) inflight = null;
	}
}

/**
 * The picker models for a page's `info`: its own list when it came with one,
 * else the cached list (an older version until the new one has arrived).
 * Reads only, so it is safe in `$derived` and on the server.
 */
export function pickerModelGroups(info: ModelCatalogInfo): PickerModelGroup[] {
	return info.groups ?? cache?.groups ?? [];
}

/** Test hook: forgets the cached list. */
export function resetModelCatalog(): void {
	cache = null;
	inflight = null;
}
