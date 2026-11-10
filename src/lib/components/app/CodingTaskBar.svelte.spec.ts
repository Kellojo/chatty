import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import type { CodingConversation } from '$lib/coding-environments.js';
import CodingTaskBar from './CodingTaskBar.svelte';

const task = (patch: Partial<CodingConversation> = {}): CodingConversation => ({
	conversationId: 'c1',
	environmentId: 'e1',
	projectId: 'p1',
	projectTitle: 'ai-chat',
	threadId: 't1',
	providerInstanceId: 'codex',
	model: 'gpt',
	runtimeMode: 'auto',
	workspaceMode: 'worktree',
	baseBranch: 'main',
	branch: 'feat/x',
	prUrl: null,
	prState: null,
	status: 'idle',
	pendingRequest: null,
	lastError: null,
	runStartedAt: null,
	diff: { insertions: 3, deletions: 1 },
	...patch
});

const DIFF = {
	sources: [
		{
			kind: 'working-tree',
			title: 'Uncommitted changes',
			baseRef: null,
			truncated: false,
			files: [
				{
					path: 'src/app.ts',
					previousPath: null,
					status: 'modified',
					additions: 1,
					deletions: 1,
					binary: false,
					truncated: false,
					lines: [
						{ kind: 'hunk', text: '@@ -1 +1 @@' },
						{ kind: 'del', text: 'const a = 1;' },
						{ kind: 'add', text: 'const a = 2;' }
					]
				}
			]
		}
	]
};

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('CodingTaskBar', () => {
	it('offers Create PR only while the agent is free', async () => {
		const oncreatepr = vi.fn();
		const busy = render(CodingTaskBar, { coding: task({ status: 'running' }), oncreatepr });
		await expect
			.element(busy.getByRole('button', { name: 'Create pull request' }))
			.not.toBeInTheDocument();
		busy.unmount();
		const free = render(CodingTaskBar, { coding: task(), oncreatepr });
		await expect
			.element(free.getByRole('button', { name: 'Create pull request' }))
			.toBeInTheDocument();
	});

	it('opens the changed files from the diff stat', async () => {
		const fetchMock = vi.fn(async () => new Response(JSON.stringify(DIFF)));
		vi.stubGlobal('fetch', fetchMock);
		const screen = render(CodingTaskBar, { coding: task() });
		await screen.getByRole('button', { name: 'Show the changed files' }).click();
		await expect.element(screen.getByText('src/app.ts')).toBeInTheDocument();
		await expect.element(screen.getByText('const a = 2;')).toBeInTheDocument();
		expect(fetchMock).toHaveBeenCalledWith('/api/coding/tasks/c1/diff');
	});
});
