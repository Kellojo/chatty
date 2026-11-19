// Precache manifest transform for the service worker (vite.config.ts).
//
// Precaching every built file made each install download ~16 MB, most of it chunks that
// load lazily (hundreds of syntax-highlighting grammars and themes, mermaid, ...) and
// that most people never use. This keeps only what the app's entry points and route
// nodes import statically, so every page can boot offline; the lazy chunks are cached
// the first time they're used (runtime caching of /_app/immutable/).
//
// Replaces @vite-pwa/sveltekit's own transform (it skips its default when one is set),
// so it also does that transform's job: precache URLs relative to the site root.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** The shape of workbox-build's precache entries (not a direct dependency here). */
interface ManifestEntry {
	url: string;
	revision: string | null;
	size: number;
}

interface ViteManifestChunk {
	file: string;
	isEntry?: boolean;
	imports?: string[];
}

const OUTPUT_DIR = '.svelte-kit/output';
const CLIENT_PREFIX = 'client/';

/** Files (relative to the client output dir) that the entries and route nodes import statically. */
async function staticChunks(): Promise<Set<string>> {
	const raw = await readFile(resolve(OUTPUT_DIR, 'client/.vite/manifest.json'), 'utf8');
	const manifest = JSON.parse(raw) as Record<string, ViteManifestChunk>;
	const roots = Object.keys(manifest).filter(
		(key) => manifest[key].isEntry || manifest[key].file.includes('/nodes/')
	);
	const seen = new Set<string>();
	const stack = [...roots];
	while (stack.length > 0) {
		const key = stack.pop()!;
		if (seen.has(key) || !manifest[key]) continue;
		seen.add(key);
		stack.push(...(manifest[key].imports ?? []));
	}
	return new Set([...seen].map((key) => manifest[key].file));
}

export function precacheTransform(webManifestName: string) {
	return async (entries: ManifestEntry[]) => {
		const keep = await staticChunks();
		const manifest = entries
			.filter((entry) => entry.url.startsWith(CLIENT_PREFIX))
			.map((entry) => ({ ...entry, url: entry.url.slice(CLIENT_PREFIX.length) }))
			.filter(
				(entry) =>
					!entry.url.endsWith('.js') || !entry.url.includes('/immutable/') || keep.has(entry.url)
			)
			// The plugin adds the web manifest itself.
			.filter((entry) => entry.url !== webManifestName);
		return { manifest, warnings: [] };
	};
}
