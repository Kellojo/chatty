import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export function isWithin(root: string, p: string): boolean {
	return p === root || p.startsWith(root + path.sep);
}

/** Lexical containment only — blind to symlinks. Prefer `resolveInsideReal`. */
export function resolveInside(root: string, rel: string): string | null {
	const abs = path.resolve(root, rel);
	return isWithin(root, abs) ? abs : null;
}

function isMissing(e: unknown): boolean {
	const code = (e as NodeJS.ErrnoException).code;
	return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Resolve `rel` under `root`, rejecting `..` escapes and symlinks anywhere in
 * the path that lead outside `root`. For paths that don't exist yet (writes),
 * the deepest existing ancestor is checked instead. A path that exists but
 * can't be resolved is a dangling symlink — writing through it would create
 * its target wherever it points — so it is rejected. Returns null on escape or
 * when `root` doesn't exist.
 */
export async function resolveInsideReal(root: string, rel: string): Promise<string | null> {
	const abs = resolveInside(root, rel);
	if (!abs) return null;
	try {
		const realRoot = await fsp.realpath(root);
		for (let probe = abs; ; probe = path.dirname(probe)) {
			try {
				return isWithin(realRoot, await fsp.realpath(probe)) ? abs : null;
			} catch (e) {
				if (!isMissing(e)) throw e;
				if (
					await fsp.lstat(probe).then(
						() => true,
						() => false
					)
				)
					return null;
				if (path.dirname(probe) === probe) return null;
			}
		}
	} catch (e) {
		if (isMissing(e)) return null;
		throw e;
	}
}

/** Synchronous `resolveInsideReal`, for callers that cannot await (isolated-vm callbacks). */
export function resolveInsideRealSync(root: string, rel: string): string | null {
	const abs = resolveInside(root, rel);
	if (!abs) return null;
	try {
		const realRoot = fs.realpathSync(root);
		for (let probe = abs; ; probe = path.dirname(probe)) {
			try {
				return isWithin(realRoot, fs.realpathSync(probe)) ? abs : null;
			} catch (e) {
				if (!isMissing(e)) throw e;
				if (fs.lstatSync(probe, { throwIfNoEntry: false })) return null;
				if (path.dirname(probe) === probe) return null;
			}
		}
	} catch (e) {
		if (isMissing(e)) return null;
		throw e;
	}
}
