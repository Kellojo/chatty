import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page as browserPage } from 'vitest/browser';
import { setMode } from 'mode-watcher';
import '../../../../routes/layout.css';
import source from '../../../coding-diff.ts?raw';
import Harness from './CodingFileHarness.svelte';

// Screenshots of file links and the file viewer for review (hill climbing).
// Run: VITE_CODING_FILE_SHOTS=<dir> VITE_CODING_FILE_ROUND=r1 pnpm exec vitest run <this file>
const SHOTS = import.meta.env.VITE_CODING_FILE_SHOTS as string | undefined;
const ROUND = (import.meta.env.VITE_CODING_FILE_ROUND as string | undefined) ?? 'r1';

const ROOT = String.raw`C:\Users\me\.t3\worktrees\ai-chat\t3code-1a2b`;
const REPLY = [
	'Diff line numbers now follow the file instead of the diff.',
	'',
	'**What changed**',
	'',
	String.raw`- The hunk header's new-file start is parsed in [coding-diff.ts:150](${ROOT}\src\lib\coding-diff.ts:150).`,
	String.raw`- [CodingDiffDialog.svelte:42](${ROOT}\src\lib\components\app\CodingDiffDialog.svelte:42) uses it for the gutter.`,
	'- Tests cover renames and truncated hunks in `src/lib/coding-diff.spec.ts:210`; `user.name` stays plain code.',
	'',
	'`pnpm check` and the unit tests pass.'
].join('\n');

const lines = source.split('\n');
/** A diff that adds lines 148-153 of the file. */
const DIFF = {
	sources: [
		{
			kind: 'branch-range',
			title: 'Against main',
			baseRef: 'main',
			truncated: false,
			files: [
				{
					path: 'src/lib/coding-diff.ts',
					previousPath: null,
					status: 'modified',
					additions: 6,
					deletions: 2,
					binary: false,
					truncated: false,
					lines: [
						{ kind: 'hunk', text: '@@ -144,8 +144,12 @@ export function parseUnifiedDiff' },
						...lines.slice(143, 147).map((text) => ({ kind: 'context', text })),
						{ kind: 'del', text: '\tfor (const line of text.split(/\\n/)) {' },
						{ kind: 'del', text: '\t\tif (line.startsWith("diff ")) {' },
						...lines.slice(147, 153).map((text) => ({ kind: 'add', text })),
						...lines.slice(153, 156).map((text) => ({ kind: 'context', text }))
					]
				},
				{
					path: 'src/lib/legacy-diff.ts',
					previousPath: null,
					status: 'deleted',
					additions: 0,
					deletions: 6,
					binary: false,
					truncated: false,
					lines: [
						{ kind: 'hunk', text: '@@ -1,6 +0,0 @@' },
						...lines.slice(0, 6).map((text) => ({ kind: 'del', text }))
					]
				},
				{
					path: 'src/lib/components/app/DiffGutter.svelte',
					previousPath: null,
					status: 'added',
					additions: 4,
					deletions: 0,
					binary: false,
					truncated: false,
					lines: [
						{ kind: 'hunk', text: '@@ -0,0 +1,4 @@' },
						{ kind: 'add', text: '<script lang="ts">' },
						{ kind: 'add', text: '\tlet { n }: { n: number } = $props();' },
						{ kind: 'add', text: '</script>' },
						{ kind: 'add', text: '<span class="gutter">{n}</span>' }
					]
				}
			]
		}
	]
};

type Shot = {
	name: string;
	width?: number;
	height?: number;
	dark?: boolean;
	open?: boolean;
	changes?: boolean;
	file?: 'ok' | 'error' | 'missing' | 'loading' | 'short';
	/** Opens the viewer from the checkpoint card instead of the link. */
	via?: 'checkpoint-file' | 'checkpoint-deleted' | 'checkpoint-unchanged' | 'review';
	/** Expands the checkpoint card's file list. */
	expand?: boolean;
	/** Scrolls the reply so the checkpoint card is in view. */
	showCheckpoint?: boolean;
};

/** A checkpoint like the ones T3 reports: relative paths with per-file line counts. */
const CHECKPOINT = {
	type: 'dynamic-tool',
	toolName: 'checkpoint',
	toolCallId: 'cp-1',
	state: 'output-available',
	input: {
		files: [],
		changes: [
			{ path: 'src/lib/coding-diff.ts', kind: 'modified', additions: 6, deletions: 2 },
			{
				path: 'src/lib/components/app/CodingDiffDialog.svelte',
				kind: 'modified',
				additions: 14,
				deletions: 9
			},
			{ path: 'src/lib/coding-diff.spec.ts', kind: 'modified', additions: 48, deletions: 0 },
			{
				path: 'src/lib/components/app/DiffGutter.svelte',
				kind: 'added',
				additions: 62,
				deletions: 0
			},
			{ path: 'src/lib/legacy-diff.ts', kind: 'deleted', additions: 0, deletions: 31 },
			{ path: 'static/diff-preview.png', kind: 'modified', additions: 0, deletions: 0 },
			{ path: 'README.md', kind: 'modified', additions: 3, deletions: 1 }
		]
	},
	output: { additions: 133, deletions: 43 }
};

const STATES: Shot[] = [
	{ name: 'checkpoint', open: false, showCheckpoint: true },
	{ name: 'checkpoint-dark', open: false, showCheckpoint: true, dark: true },
	{ name: 'checkpoint-mobile', open: false, showCheckpoint: true, width: 390, height: 844 },
	{ name: 'checkpoint-expanded', open: false, showCheckpoint: true, expand: true },
	{ name: 'checkpoint-open-file', via: 'checkpoint-file' },
	{ name: 'checkpoint-open-deleted', via: 'checkpoint-deleted' },
	{ name: 'checkpoint-open-unchanged', via: 'checkpoint-unchanged', expand: true },
	{ name: 'file-view' },
	{ name: 'file-view-dark', dark: true },
	{ name: 'changes', changes: true },
	{ name: 'mobile-file-view', width: 390, height: 844 },
	{ name: 'review-changes', via: 'review' }
];

afterEach(() => {
	vi.unstubAllGlobals();
	document.documentElement.classList.remove('dark');
	setMode('light');
});

describe.skipIf(!SHOTS)('Coding file viewer screenshots', () => {
	for (const s of STATES) {
		it(s.name, async () => {
			const width = s.width ?? 1280;
			const height = s.height ?? 800;
			if (s.dark) {
				document.documentElement.classList.add('dark');
				setMode('dark');
			}
			vi.stubGlobal(
				'fetch',
				vi.fn(async (input: RequestInfo | URL) => {
					const url = String(input);
					if (url.endsWith('/diff')) return Response.json(DIFF);
					if (s.file === 'loading') return new Promise<Response>(() => {});
					if (s.file === 'error') {
						return Response.json(
							{
								message:
									'Re-pair this coding environment to open files from it (it needs file read access)'
							},
							{ status: 403 }
						);
					}
					const path = new URL(url, 'http://x').searchParams.get('path') ?? '';
					const relative = path.startsWith(ROOT) ? path.slice(ROOT.length + 1) : path;
					return Response.json({
						absolutePath: path.startsWith(ROOT)
							? path
							: `${ROOT}\\${relative.replaceAll('/', '\\')}`,
						workspacePath: relative.replaceAll('\\', '/'),
						exists: s.file !== 'missing' && !path.includes('legacy-diff'),
						contents:
							s.file === 'missing'
								? ''
								: s.file === 'short'
									? lines.slice(0, 40).join('\n')
									: source,
						byteLength: source.length,
						truncated: false
					});
				})
			);
			document.body.style.margin = '0';
			document.body.style.background = 'var(--background)';
			document.body.style.color = 'var(--foreground)';
			const frame = window.frameElement as HTMLElement | null;
			const host = frame?.parentElement;
			if (host) {
				host.style.transform = 'none';
				host.setAttribute('data-scale', '1');
			}
			if (frame) {
				frame.style.cssText = `position:fixed;top:0;left:0;z-index:2147483647;width:${width}px;height:${height}px;border:0;`;
			}
			await browserPage.viewport(width, height);
			const screen = render(Harness, { content: REPLY, checkpoint: CHECKPOINT });
			const link = screen.getByRole('link', { name: 'coding-diff.ts:150' });
			await expect.element(link).toBeVisible();
			// Let the code block create Streamdown's highlighter.
			await new Promise((r) => setTimeout(r, 1200));
			if (s.expand) {
				(screen.getByRole('button', { name: /Show \d+ more/ }).element() as HTMLElement).click();
				await new Promise((r) => setTimeout(r, 300));
			}
			if (s.showCheckpoint) {
				screen.container
					.querySelector('section[aria-label^="Checkpoint"]')
					?.scrollIntoView({ block: 'end' });
				await new Promise((r) => setTimeout(r, 400));
			}
			if (s.via === 'review') {
				(
					screen.getByRole('button', { name: 'Review all changes' }).element() as HTMLElement
				).click();
				await expect.element(screen.getByRole('dialog')).toBeVisible();
				await new Promise((r) => setTimeout(r, 1200));
			} else if (s.open !== false) {
				const opener =
					s.via === 'checkpoint-file'
						? screen.getByRole('button', { name: /coding-diff\.ts/ }).first()
						: s.via === 'checkpoint-unchanged'
							? screen.getByRole('button', { name: /README/ })
							: s.via === 'checkpoint-deleted'
								? screen.getByRole('button', { name: /legacy-diff\.ts/ })
								: link;
				(opener.element() as HTMLElement).click();
				await expect.element(screen.getByRole('dialog')).toBeVisible();
				await new Promise((r) => setTimeout(r, 1200));
				if (s.changes) {
					(
						screen
							.getByRole('dialog')
							.getByRole('button', { name: /Changes/ })
							.element() as HTMLElement
					).click();
					await new Promise((r) => setTimeout(r, 400));
				}
			}
			await browserPage.screenshot({ path: `${SHOTS}/${ROUND}-${s.name}.png`, scale: 'css' });
		});
	}
});
