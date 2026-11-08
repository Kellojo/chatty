import { describe, expect, it } from 'vitest';
import {
	defaultDiffSource,
	MAX_DIFF_LINES_PER_FILE,
	parseUnifiedDiff,
	type CodingDiffSource
} from './coding-diff.js';

const DIFF = [
	'diff --git a/src/app.ts b/src/app.ts',
	'index 1111111..2222222 100644',
	'--- a/src/app.ts',
	'+++ b/src/app.ts',
	'@@ -1,3 +1,3 @@',
	' import x from "x";',
	'-const a = 1;',
	'+const a = 2;',
	' export { a };',
	'\\ No newline at end of file',
	'diff --git a/new.md b/new.md',
	'new file mode 100644',
	'--- /dev/null',
	'+++ b/new.md',
	'@@ -0,0 +1,2 @@',
	'+# Title',
	'+',
	'diff --git a/old.txt b/old.txt',
	'deleted file mode 100644',
	'--- a/old.txt',
	'+++ /dev/null',
	'@@ -1 +0,0 @@',
	'-gone',
	'diff --git a/a.txt b/b.txt',
	'similarity index 100%',
	'rename from a.txt',
	'rename to b.txt',
	'diff --git a/logo.png b/logo.png',
	'Binary files a/logo.png and b/logo.png differ',
	''
].join('\n');

describe('parseUnifiedDiff', () => {
	it('splits a git diff into files with their status and counts', () => {
		const files = parseUnifiedDiff(DIFF);
		expect(files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
			['src/app.ts', 'modified', 1, 1],
			['new.md', 'added', 2, 0],
			['old.txt', 'deleted', 0, 1],
			['b.txt', 'renamed', 0, 0],
			['logo.png', 'modified', 0, 0]
		]);
		expect(files[3].previousPath).toBe('a.txt');
		expect(files[4].binary).toBe(true);
	});

	it('keeps hunk headers, context and changed lines in order', () => {
		const [file] = parseUnifiedDiff(DIFF);
		expect(file.lines).toEqual([
			{ kind: 'hunk', text: '@@ -1,3 +1,3 @@' },
			{ kind: 'context', text: 'import x from "x";' },
			{ kind: 'del', text: 'const a = 1;' },
			{ kind: 'add', text: 'const a = 2;' },
			{ kind: 'context', text: 'export { a };' },
			{ kind: 'meta', text: '\\ No newline at end of file' }
		]);
		// A removed line that looks like a header is still a removed line.
		const tricky = parseUnifiedDiff(
			['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1 +1 @@', '--- y', '+++ z'].join('\n')
		);
		expect(tricky[0].path).toBe('x');
		expect(tricky[0]).toMatchObject({ additions: 1, deletions: 1 });
	});

	it('truncates long files but keeps exact counts', () => {
		const long = [
			'diff --git a/big b/big',
			'--- a/big',
			'+++ b/big',
			'@@ -0,0 +1,3000 @@',
			...Array.from({ length: 3000 }, (_, i) => `+line ${i}`)
		].join('\n');
		const [file] = parseUnifiedDiff(long);
		expect(file.additions).toBe(3000);
		expect(file.lines).toHaveLength(MAX_DIFF_LINES_PER_FILE);
		expect(file.truncated).toBe(true);
	});

	it('returns nothing for an empty diff', () => {
		expect(parseUnifiedDiff('')).toEqual([]);
	});
});

describe('defaultDiffSource', () => {
	const source = (kind: CodingDiffSource['kind'], files: number): CodingDiffSource => ({
		kind,
		title: kind,
		baseRef: null,
		truncated: false,
		files: parseUnifiedDiff(DIFF).slice(0, files)
	});

	it('prefers the branch changes, then the working tree', () => {
		expect(defaultDiffSource([source('working-tree', 1), source('branch-range', 2)])?.kind).toBe(
			'branch-range'
		);
		expect(defaultDiffSource([source('working-tree', 1), source('branch-range', 0)])?.kind).toBe(
			'working-tree'
		);
		expect(defaultDiffSource([])).toBeNull();
	});
});
