import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveInsideReal, resolveInsideRealSync } from './safePath.js';

let tmp: string;
let root: string;
let outside: string;

// Directory junctions need no privileges on Windows; file symlinks may.
async function linkDir(target: string, at: string) {
	await fs.symlink(target, at, process.platform === 'win32' ? 'junction' : 'dir');
}
async function tryLinkFile(target: string, at: string): Promise<boolean> {
	try {
		await fs.symlink(target, at, 'file');
		return true;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === 'EPERM') return false;
		throw e;
	}
}

beforeEach(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'safepath-'));
	root = path.join(tmp, 'root');
	outside = path.join(tmp, 'outside');
	await fs.mkdir(path.join(root, 'sub'), { recursive: true });
	await fs.mkdir(outside);
	await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
	await fs.writeFile(path.join(root, 'sub', 'ok.txt'), 'ok');
});

afterEach(async () => {
	await fs.rm(tmp, { recursive: true, force: true });
});

describe.each([
	['async', (r: string, p: string) => resolveInsideReal(r, p)],
	['sync', async (r: string, p: string) => resolveInsideRealSync(r, p)]
])('resolveInsideReal (%s)', (_name, resolve) => {
	it('allows existing and not-yet-existing paths inside root', async () => {
		expect(await resolve(root, 'sub/ok.txt')).toBe(path.join(root, 'sub', 'ok.txt'));
		expect(await resolve(root, 'new/dir/file.txt')).toBe(path.join(root, 'new', 'dir', 'file.txt'));
		expect(await resolve(root, '.')).toBe(root);
	});

	it('rejects lexical escapes', async () => {
		expect(await resolve(root, '../outside/secret.txt')).toBeNull();
		expect(await resolve(root, path.join(outside, 'secret.txt'))).toBeNull();
	});

	it('rejects a directory symlink pointing outside, for reads and writes', async () => {
		await linkDir(outside, path.join(root, 'link'));
		expect(await resolve(root, 'link/secret.txt')).toBeNull();
		expect(await resolve(root, 'link/new.txt')).toBeNull();
		expect(await resolve(root, 'link')).toBeNull();
	});

	it('allows a symlink that stays inside root', async () => {
		await linkDir(path.join(root, 'sub'), path.join(root, 'alias'));
		expect(await resolve(root, 'alias/ok.txt')).toBe(path.join(root, 'alias', 'ok.txt'));
	});

	it('rejects file symlinks pointing outside, including dangling ones', async (ctx) => {
		if (!(await tryLinkFile(path.join(outside, 'secret.txt'), path.join(root, 'f')))) {
			ctx.skip();
		}
		await tryLinkFile(path.join(outside, 'not-yet.txt'), path.join(root, 'dangling'));
		expect(await resolve(root, 'f')).toBeNull();
		expect(await resolve(root, 'dangling')).toBeNull();
	});

	it('returns null when root does not exist', async () => {
		expect(await resolve(path.join(tmp, 'missing'), 'x')).toBeNull();
	});
});
