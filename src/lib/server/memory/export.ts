import fsp from 'node:fs/promises';
import path from 'node:path';
import { zipSync, type Zippable } from 'fflate';
import { listConceptPaths } from './bundle.js';
import { bundleDir } from './paths.js';
import type { MemoryScope } from './paths.js';

export interface MemoryArchive {
	bytes: Uint8Array;
	count: number;
}

/**
 * Every concept file in a bundle, zipped with its folder layout kept, so it can
 * be read anywhere or copied back into a memory volume. Private concepts are
 * included: only the bundle's owner (or an admin, for shared memory) may call it.
 */
export async function buildMemoryArchive(
	scope: MemoryScope,
	userId: string
): Promise<MemoryArchive> {
	const root = bundleDir(scope, userId);
	const files: Zippable = {};
	let count = 0;
	for (const rel of await listConceptPaths(scope, userId)) {
		let raw: Uint8Array;
		try {
			raw = await fsp.readFile(path.join(root, ...rel.split('/')));
		} catch {
			continue; // removed while exporting
		}
		files[rel] = raw;
		count++;
	}
	return { bytes: zipSync(files, { level: 6 }), count };
}

/** `chatty-memory-2026-11-26.zip`, or `chatty-shared-memory-…` for shared memory. */
export function memoryArchiveFileName(scope: MemoryScope, now: number): string {
	const date = new Date(now).toISOString().slice(0, 10);
	return `chatty-${scope === 'shared' ? 'shared-' : ''}memory-${date}.zip`;
}
