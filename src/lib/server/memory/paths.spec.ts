import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';
process.env.MEMORY_VOLUME = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-mem-paths-'));

const paths = await import('./paths.js');

describe('normalizeConceptPath', () => {
	it('accepts simple and nested posix paths', () => {
		expect(paths.normalizeConceptPath('john.md')).toBe('john.md');
		expect(paths.normalizeConceptPath('ok/deep.md')).toBe('ok/deep.md');
		expect(paths.normalizeConceptPath('a/b/c/d.md')).toBe('a/b/c/d.md');
	});

	it('converts backslashes to forward slashes', () => {
		expect(paths.normalizeConceptPath('ok\\deep.md')).toBe('ok/deep.md');
	});

	it('rejects traversal segments', () => {
		expect(paths.normalizeConceptPath('../x.md')).toBeNull();
		expect(paths.normalizeConceptPath('a/../b.md')).toBeNull();
		expect(paths.normalizeConceptPath('..')).toBeNull();
	});

	it('rejects absolute paths', () => {
		expect(paths.normalizeConceptPath('/abs.md')).toBeNull();
		expect(paths.normalizeConceptPath('C:\\abs\\x.md')).toBeNull();
	});

	it('rejects empty and dot segments', () => {
		expect(paths.normalizeConceptPath('')).toBeNull();
		expect(paths.normalizeConceptPath('a//b.md')).toBeNull();
		expect(paths.normalizeConceptPath('./a.md')).toBeNull();
		expect(paths.normalizeConceptPath('a/./b.md')).toBeNull();
	});

	it('rejects index.md at any level', () => {
		expect(paths.normalizeConceptPath('index.md')).toBeNull();
		expect(paths.normalizeConceptPath('dir/index.md')).toBeNull();
	});

	it('appends .md when the extension is missing', () => {
		expect(paths.normalizeConceptPath('no-extension')).toBe('no-extension.md');
		expect(paths.normalizeConceptPath('a/b.txt')).toBe('a/b.txt.md');
	});

	it('rejects index.md in any letter case (case-insensitive file systems)', () => {
		expect(paths.normalizeConceptPath('Index.md')).toBeNull();
		expect(paths.normalizeConceptPath('INDEX.md')).toBeNull();
		expect(paths.normalizeConceptPath('dir/Index')).toBeNull();
		expect(paths.normalizeConceptPath('Index/note.md')).toBe('Index/note.md');
	});

	it('still rejects index after appending the extension', () => {
		expect(paths.normalizeConceptPath('index')).toBeNull();
		expect(paths.normalizeConceptPath('dir/index')).toBeNull();
	});
});

describe('resolveConceptAbs', () => {
	it('resolves inside the user bundle dir', () => {
		const abs = paths.resolveConceptAbs('user', 'u1', 'people/john.md');
		expect(abs).toBe(path.join(paths.bundleDir('user', 'u1'), 'people', 'john.md'));
	});

	it('resolves inside the shared bundle dir', () => {
		const abs = paths.resolveConceptAbs('shared', 'u1', 'glossary.md');
		expect(abs).toBe(path.join(paths.bundleDir('shared', 'u1'), 'glossary.md'));
	});

	it('returns null for invalid or escaping paths', () => {
		expect(paths.resolveConceptAbs('user', 'u1', '../escape.md')).toBeNull();
		expect(paths.resolveConceptAbs('user', 'u1', 'index.md')).toBeNull();
		expect(paths.resolveConceptAbs('user', 'u1', '/abs.md')).toBeNull();
	});
});

describe('scope helpers', () => {
	it('computes bundle dirs and fts scopes', () => {
		expect(paths.bundleDir('user', 'u1')).toBe(path.join(paths.memoryRoot(), 'u1'));
		expect(paths.bundleDir('shared', 'u1')).toBe(path.join(paths.memoryRoot(), 'shared'));
		expect(paths.ftsScope('user', 'u1')).toBe('user:u1');
		expect(paths.ftsScope('shared', 'u1')).toBe('shared');
	});
});
