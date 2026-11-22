import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import Harness from './__shots__/CodingFileHarness.svelte';

const FILE = {
	absolutePath: '/wt/t1/src/http.ts',
	workspacePath: 'src/http.ts',
	exists: true,
	contents: 'const a = 1;\nconst b = 2;\nconst c = 3;\n',
	byteLength: 39,
	truncated: false
};
const DIFF = {
	sources: [
		{
			kind: 'working-tree',
			title: 'Uncommitted changes',
			baseRef: null,
			truncated: false,
			files: [
				{
					path: 'src/http.ts',
					previousPath: null,
					status: 'modified',
					additions: 1,
					deletions: 1,
					binary: false,
					truncated: false,
					lines: [
						{ kind: 'hunk', text: '@@ -1,3 +1,3 @@' },
						{ kind: 'context', text: 'const a = 1;' },
						{ kind: 'del', text: 'const b = 0;' },
						{ kind: 'add', text: 'const b = 2;' },
						{ kind: 'context', text: 'const c = 3;' }
					]
				}
			]
		}
	]
};

function stubT3(file: unknown = FILE, status = 200) {
	const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.endsWith('/diff')) return Response.json(DIFF);
		return Response.json(file, { status });
	});
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('coding file links', () => {
	it('opens a linked file at its line, with the lines the task changed', async () => {
		const fetchMock = stubT3();
		const screen = render(Harness, { content: 'See [http.ts:2](/wt/t1/src/http.ts:2).' });
		const link = screen.getByRole('link', { name: 'http.ts:2' });
		await expect
			.element(link)
			.toHaveAttribute('href', '/chat/c-1?file=%2Fwt%2Ft1%2Fsrc%2Fhttp.ts&line=2');
		await link.click();

		const dialog = screen.getByRole('dialog');
		await expect.element(dialog.getByText('Line 2', { exact: true })).toBeVisible();
		await expect.element(dialog.getByText('const c = 3;')).toBeVisible();
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/coding/tasks/c-1/file?path=%2Fwt%2Ft1%2Fsrc%2Fhttp.ts',
			expect.objectContaining({ signal: expect.any(AbortSignal) })
		);
		const line2 = dialog.element().querySelector('[data-line="2"]');
		expect(line2?.className).toContain('bg-amber-400/25');
		// Highlighted even though the chat has no code block that loaded the highlighter.
		await expect
			.poll(() => dialog.element().querySelector('[data-line="1"] span[style*="color"]'), {
				timeout: 10_000
			})
			.toBeTruthy();

		await dialog.getByRole('button', { name: /Changes/ }).click();
		await expect.element(dialog.getByText('const b = 0;')).toBeVisible();
	});

	it("shows T3's reason when a file can't be opened", async () => {
		stubT3({ message: "This is a binary file, so it can't be shown." }, 422);
		const screen = render(Harness, { content: '[logo](/wt/t1/logo.bin)' });
		await screen.getByRole('link', { name: 'logo' }).click();
		await expect
			.element(screen.getByText("This is a binary file, so it can't be shown."))
			.toBeVisible();
		await expect.element(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
	});

	it('keeps Windows paths intact', async () => {
		stubT3();
		const screen = render(Harness, { content: String.raw`[a.ts](C:\me\.t3\a.ts:4)` });
		await expect
			.element(screen.getByRole('link', { name: 'a.ts' }))
			.toHaveAttribute(
				'href',
				`/chat/c-1?file=${encodeURIComponent(String.raw`C:\me\.t3\a.ts`)}&line=4`
			);
	});

	it('links inline code that names a file, but not other code or code inside a link', async () => {
		stubT3();
		const screen = render(Harness, {
			content: 'Edit `src/http.ts:2`, not `user.name`; see [`b.ts`](/wt/t1/b.ts).'
		});
		const code = screen.getByRole('link', { name: 'src/http.ts:2' });
		await expect.element(code).toHaveAttribute('href', '/chat/c-1?file=src%2Fhttp.ts&line=2');
		expect(screen.container.querySelectorAll('a[data-coding-file]')).toHaveLength(2);
		expect(screen.container.querySelectorAll('a a')).toHaveLength(0);
		await code.click();
		await expect.element(screen.getByRole('dialog').getByText('const c = 3;')).toBeVisible();
	});

	it('leaves links alone outside coding chats and for web URLs', async () => {
		stubT3();
		const screen = render(Harness, {
			content: '[a](/wt/t1/a.ts) [site](https://example.com/a.ts)',
			enabled: false
		});
		await expect
			.element(screen.getByRole('link', { name: 'a' }))
			.toHaveAttribute('href', '/wt/t1/a.ts');
		expect(screen.container.querySelector('[data-coding-file]')).toBeNull();
	});
});
