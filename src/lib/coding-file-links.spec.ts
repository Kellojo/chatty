import { describe, expect, it } from 'vitest';
import {
	codingFileHref,
	fileLanguage,
	parseCodingFileHref,
	parseCodingFileRef,
	parseInlineCodeFileRef,
	readCodingFileParams,
	splitFilePath
} from './coding-file-links.js';

describe('parseCodingFileRef', () => {
	it('reads absolute paths with and without lines', () => {
		expect(parseCodingFileRef('/home/me/repo/src/http.ts:42')).toEqual({
			path: '/home/me/repo/src/http.ts',
			line: 42,
			endLine: null
		});
		expect(parseCodingFileRef(String.raw`C:\repo\src\a.ts`)).toEqual({
			path: String.raw`C:\repo\src\a.ts`,
			line: null,
			endLine: null
		});
		expect(parseCodingFileRef('C:/repo/Makefile:3:7')?.line).toBe(3);
		expect(parseCodingFileRef(String.raw`\\nas\share\a.md`)?.path).toBe(
			String.raw`\\nas\share\a.md`
		);
		expect(parseCodingFileRef('~/notes/todo.md')?.path).toBe('~/notes/todo.md');
	});

	it('reads ranges, GitHub-style anchors and file URLs', () => {
		expect(parseCodingFileRef('/r/a.ts:3-9')).toEqual({ path: '/r/a.ts', line: 3, endLine: 9 });
		expect(parseCodingFileRef('src/a.ts#L3-L9')).toEqual({ path: 'src/a.ts', line: 3, endLine: 9 });
		expect(parseCodingFileRef('src/a.ts#L5C2')).toEqual({
			path: 'src/a.ts',
			line: 5,
			endLine: null
		});
		expect(parseCodingFileRef('/r/a.ts:9-3')?.endLine).toBeNull();
		expect(parseCodingFileRef('file:///C:/repo/a%20b.ts:4')).toEqual({
			path: 'C:/repo/a b.ts',
			line: 4,
			endLine: null
		});
		expect(parseCodingFileRef('/C:/repo/a.ts')?.path).toBe('C:/repo/a.ts');
	});

	it('reads workspace-relative paths', () => {
		expect(parseCodingFileRef('src/lib/a.svelte')?.path).toBe('src/lib/a.svelte');
		expect(parseCodingFileRef('README.md')?.path).toBe('README.md');
		expect(parseCodingFileRef('./scripts/run:12')?.path).toBe('./scripts/run');
		expect(parseCodingFileRef('.env')?.path).toBe('.env');
	});

	it('leaves web and app links alone', () => {
		for (const href of [
			'https://example.com/a.ts',
			'mailto:me@example.com',
			'//cdn.example.com/a.js',
			'#section',
			'?tab=2',
			'/settings',
			'/chat/abc',
			'example.com',
			'docs.example.io/guide',
			'src/a.md#intro',
			'',
			't3-thread://v2/a/b'
		]) {
			expect(parseCodingFileRef(href), href).toBeNull();
		}
	});
});

describe('codingFileHref', () => {
	it('round-trips through the chat URL', () => {
		const ref = { path: String.raw`C:\repo\a b.ts`, line: 3, endLine: 9 };
		const href = codingFileHref('c-1', ref);
		expect(href.startsWith('/chat/c-1?file=')).toBe(true);
		expect(parseCodingFileHref(href, 'c-1')).toEqual(ref);
		expect(parseCodingFileHref(href, 'c-2')).toBeNull();
		expect(parseCodingFileHref('/chat/c-1', 'c-1')).toBeNull();
	});

	it('drops invalid lines', () => {
		expect(readCodingFileParams(new URLSearchParams('file=a.ts&line=0&end=4'))).toEqual({
			path: 'a.ts',
			line: null,
			endLine: null
		});
		expect(readCodingFileParams(new URLSearchParams('line=4'))).toBeNull();
	});
});

describe('file helpers', () => {
	it('splits paths of either separator', () => {
		expect(splitFilePath(String.raw`C:\repo\src\a.ts`)).toEqual({
			name: 'a.ts',
			dir: String.raw`C:\repo\src`
		});
		expect(splitFilePath('/r/a.ts')).toEqual({ name: 'a.ts', dir: '/r' });
		expect(splitFilePath('a.ts')).toEqual({ name: 'a.ts', dir: '' });
	});

	it('maps extensions to highlighter languages', () => {
		expect(fileLanguage('a.ts')).toBe('typescript');
		expect(fileLanguage('Page.SVELTE')).toBe('svelte');
		expect(fileLanguage('Dockerfile')).toBe('docker');
		expect(fileLanguage('notes')).toBeNull();
		expect(fileLanguage('a.unknownext')).toBeNull();
	});
});

describe('parseInlineCodeFileRef', () => {
	it('reads code spans that name a file by folder or line', () => {
		expect(parseInlineCodeFileRef('src/a.ts:42')).toEqual({
			path: 'src/a.ts',
			line: 42,
			endLine: null
		});
		expect(parseInlineCodeFileRef('README.md:3')?.path).toBe('README.md');
		expect(parseInlineCodeFileRef(String.raw`C:\repo\a.svelte`)?.path).toBe(
			String.raw`C:\repo\a.svelte`
		);
		expect(parseInlineCodeFileRef('.github/workflows/ci.yml')?.path).toBe(
			'.github/workflows/ci.yml'
		);
		expect(parseInlineCodeFileRef('Dockerfile:12')?.line).toBe(12);
		expect(parseInlineCodeFileRef('Makefile')).toBeNull();
	});

	it('leaves other code alone', () => {
		for (const code of [
			'user.name',
			'package.json',
			'pnpm test:unit',
			'$lib/coding-diff.ts',
			'@lucide/svelte/icons/copy',
			'node:fs/promises',
			'text/html',
			'1.5/2.0',
			'a.b.c()',
			'https://example.com/a.ts'
		]) {
			expect(parseInlineCodeFileRef(code), code).toBeNull();
		}
	});
});
