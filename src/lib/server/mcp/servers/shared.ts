import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export function text(t: string): CallToolResult {
	return { content: [{ type: 'text', text: t }] };
}

export function err(t: string): CallToolResult {
	return { content: [{ type: 'text', text: `error: ${t}` }], isError: true };
}

export function toPosix(p: string): string {
	return p.split(path.sep).join('/');
}

export interface WalkEntry {
	abs: string;
	rel: string;
	isDir: boolean;
}

export function walk(root: string): WalkEntry[] {
	const out: WalkEntry[] = [];
	const recurse = (dir: string): void => {
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			const abs = path.join(dir, e.name);
			if (e.isDirectory()) {
				out.push({ abs, rel: toPosix(path.relative(root, abs)), isDir: true });
				recurse(abs);
			} else if (e.isFile()) {
				out.push({ abs, rel: toPosix(path.relative(root, abs)), isDir: false });
			}
		}
	};
	recurse(root);
	return out;
}

export function looksTextual(abs: string, maxBytes: number): boolean {
	let size: number;
	try {
		size = fs.statSync(abs).size;
	} catch {
		return false;
	}
	if (size > maxBytes) return false;
	const fd = fs.openSync(abs, 'r');
	try {
		const head = Buffer.alloc(Math.min(8192, size));
		const read = fs.readSync(fd, head, 0, head.length, 0);
		return !head.subarray(0, read).includes(0);
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * Directories that are almost never what a search is after but can hold
 * hundreds of thousands of files. fs_grep / fs_glob skip them unless the
 * caller's path or pattern names one explicitly.
 */
export const HEAVY_DIRS: ReadonlySet<string> = new Set([
	'.git',
	'node_modules',
	'dist',
	'build',
	'.svelte-kit',
	'target',
	'.venv',
	'__pycache__'
]);

/** True when any `/`- or `\`-separated segment of `p` is a heavy dir name. */
export function namesHeavyDir(p: string): boolean {
	return p.split(/[\\/]/).some((s) => HEAVY_DIRS.has(s));
}

export interface WalkOptions {
	/** Directory names to neither yield nor descend into. */
	skipDirs?: ReadonlySet<string>;
	/** Paths in yielded entries are relative to this (defaults to the walk root). */
	relTo?: string;
}

/**
 * Lazily walks `root` depth-first (directories before their contents,
 * symlinks not followed), so callers can stop early without listing the
 * whole tree. Unreadable directories are skipped.
 */
export async function* walkIter(
	root: string,
	options: WalkOptions = {}
): AsyncGenerator<WalkEntry, void, undefined> {
	const relTo = options.relTo ?? root;
	const skip = options.skipDirs;
	async function* recurse(dir: string): AsyncGenerator<WalkEntry, void, undefined> {
		let entries;
		try {
			entries = await fsp.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const abs = path.join(dir, e.name);
			if (e.isDirectory()) {
				if (skip?.has(e.name)) continue;
				yield { abs, rel: toPosix(path.relative(relTo, abs)), isDir: true };
				yield* recurse(abs);
			} else if (e.isFile()) {
				yield { abs, rel: toPosix(path.relative(relTo, abs)), isDir: false };
			}
		}
	}
	yield* recurse(root);
}
