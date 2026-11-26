import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page as browserPage } from 'vitest/browser';
import { setMode } from 'mode-watcher';
import '../../../../routes/layout.css';
import { CODING_OPTIONS_KEY } from '$lib/offline-cache.js';
import Harness from './DraftHarness.svelte';

const SHOTS = import.meta.env.VITE_DRAFT_SHOTS as string | undefined;
const ROUND = (import.meta.env.VITE_DRAFT_ROUND as string | undefined) ?? 'r1';

// The environment's last loaded options, as the start page saved them.
const SAVED = {
	'env-1': {
		options: {
			projects: [
				{
					id: 'p1',
					title: 'ai-chat',
					defaultBranch: 'main',
					isGitRepo: true,
					defaultModel: null,
					defaultAutonomy: null,
					defaultWorkspaceMode: null
				}
			],
			models: [
				{
					providerInstanceId: 'claudeAgent',
					provider: 'claudeAgent',
					providerLabel: 'Claude',
					model: 'claude-opus-5-5',
					label: 'Claude Opus 5.5',
					favorite: true
				}
			],
			defaultModel: null,
			defaultAutonomy: 'auto-edits',
			defaultWorkspaceMode: 'worktree'
		},
		branches: {
			p1: {
				isRepo: true,
				branches: [{ name: 'main', isDefault: true, current: true }]
			}
		}
	}
};

afterEach(() => {
	document.documentElement.classList.remove('dark');
	setMode('light');
	vi.unstubAllGlobals();
	localStorage.removeItem(CODING_OPTIONS_KEY);
	for (const c of document.querySelectorAll('[data-shot-column]')) c.remove();
});

type Shot = {
	name: string;
	kind: 'start' | 'draft';
	width?: number;
	dark?: boolean;
	autoStart?: boolean;
	error?: string;
	starting?: boolean;
};

const STATES: Shot[] = [
	{ name: 'start-offline', kind: 'start' },
	{ name: 'start-offline-mobile', kind: 'start', width: 390 },
	{ name: 'start-offline-dark', kind: 'start', dark: true },
	{ name: 'draft-auto', kind: 'draft' },
	{ name: 'draft-manual', kind: 'draft', autoStart: false },
	{
		name: 'draft-error',
		kind: 'draft',
		autoStart: false,
		error: 'Project not found on this environment'
	},
	{ name: 'draft-mobile', kind: 'draft', width: 390 },
	{
		name: 'draft-error-mobile',
		kind: 'draft',
		width: 390,
		autoStart: false,
		error: 'Project not found on this environment'
	},
	{ name: 'draft-dark', kind: 'draft', dark: true, starting: true }
];

describe.skipIf(!SHOTS)('Offline draft screenshots', () => {
	for (const s of STATES) {
		it(s.name, async () => {
			const width = s.width ?? 1000;
			localStorage.setItem(CODING_OPTIONS_KEY, JSON.stringify(SAVED));
			vi.stubGlobal(
				'fetch',
				vi.fn(async () =>
					Response.json(
						{ message: 'Could not reach http://workstation:3773 (ECONNREFUSED)' },
						{ status: 502 }
					)
				)
			);
			if (s.dark) {
				document.documentElement.classList.add('dark');
				setMode('dark');
			}
			document.body.style.margin = '0';
			document.body.style.background = 'var(--background)';
			const frame = window.frameElement as HTMLElement | null;
			const host = frame?.parentElement;
			if (host) {
				host.style.transform = 'none';
				host.setAttribute('data-scale', '1');
			}
			if (frame) {
				frame.style.cssText = `position:fixed;top:0;left:0;z-index:2147483647;width:${width}px;height:700px;border:0;`;
			}
			await browserPage.viewport(width, 700);
			const screen = render(Harness, {
				kind: s.kind,
				autoStart: s.autoStart ?? true,
				error: s.error ?? null,
				starting: s.starting ?? false
			});
			const column = document.createElement('div');
			column.dataset.shotColumn = '';
			column.className = 'w-full bg-background p-4 pb-8 text-foreground';
			screen.container.parentElement!.insertBefore(column, screen.container);
			column.appendChild(screen.container);
			if (s.kind === 'start') {
				await expect.poll(() => column.textContent ?? '').toContain("Can't reach");
			} else {
				await expect.poll(() => column.textContent ?? '').toContain('Draft');
			}
			await new Promise((r) => setTimeout(r, 600));
			await browserPage.screenshot({
				path: `${SHOTS}/${ROUND}-${s.name}.png`,
				scale: 'css',
				element: column
			});
		});
	}
});
