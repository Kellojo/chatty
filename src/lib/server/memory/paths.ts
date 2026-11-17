import path from 'node:path';
import { config } from '../config.js';

export type MemoryScope = 'user' | 'shared';

export function memoryRoot(): string {
	return path.resolve(config.MEMORY_VOLUME);
}

export function bundleDir(scope: MemoryScope, userId: string): string {
	return path.join(memoryRoot(), scope === 'shared' ? 'shared' : userId);
}

export function ftsScope(scope: MemoryScope, userId: string): string {
	return scope === 'shared' ? 'shared' : `user:${userId}`;
}

export function normalizeConceptPath(relPath: string): string | null {
	const posix = relPath.split('\\').join('/');
	if (posix.length === 0 || posix.startsWith('/') || /^[a-zA-Z]:/.test(posix)) return null;
	const segments = posix.split('/');
	if (segments.some((s) => s.length === 0 || s === '.' || s === '..')) return null;
	const last = segments.length - 1;
	if (!segments[last].endsWith('.md')) segments[last] = `${segments[last]}.md`;
	// Case-insensitively: on a case-insensitive file system Index.md is the generated index.
	if (segments.some((s) => s.toLowerCase() === 'index.md')) return null;
	return segments.join('/');
}

export function resolveConceptAbs(
	scope: MemoryScope,
	userId: string,
	relPath: string
): string | null {
	const normalized = normalizeConceptPath(relPath);
	if (!normalized) return null;
	const root = bundleDir(scope, userId);
	const abs = path.resolve(root, normalized);
	if (abs !== root && !abs.startsWith(root + path.sep)) return null;
	return abs;
}
