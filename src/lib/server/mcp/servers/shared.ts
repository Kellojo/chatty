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

export function resolveInside(root: string, rel: string): string | null {
	const abs = path.resolve(root, rel);
	if (abs !== root && !abs.startsWith(root + path.sep)) return null;
	return abs;
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

export async function walkAsync(root: string): Promise<WalkEntry[]> {
	const out: WalkEntry[] = [];
	const recurse = async (dir: string): Promise<void> => {
		const entries = await fsp.readdir(dir, { withFileTypes: true });
		for (const e of entries) {
			const abs = path.join(dir, e.name);
			if (e.isDirectory()) {
				out.push({ abs, rel: toPosix(path.relative(root, abs)), isDir: true });
				await recurse(abs);
			} else if (e.isFile()) {
				out.push({ abs, rel: toPosix(path.relative(root, abs)), isDir: false });
			}
		}
	};
	await recurse(root);
	return out;
}

export async function looksTextualAsync(abs: string, maxBytes: number): Promise<boolean> {
	let size: number;
	try {
		size = (await fsp.stat(abs)).size;
	} catch {
		return false;
	}
	if (size > maxBytes) return false;
	const handle = await fsp.open(abs, 'r');
	try {
		const head = Buffer.alloc(Math.min(8192, size));
		const { bytesRead } = await handle.read(head, 0, head.length, 0);
		return !head.subarray(0, bytesRead).includes(0);
	} finally {
		await handle.close();
	}
}
