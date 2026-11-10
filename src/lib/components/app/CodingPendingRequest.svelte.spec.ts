import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page as browserPage, userEvent } from 'vitest/browser';
import '../../../routes/layout.css';
import { askUserRequest } from '$lib/ask-user.js';
import type { CodingPendingRequest as Request } from '$lib/coding-environments.js';
import CodingPendingRequest from './CodingPendingRequest.svelte';

/** Every kind of request the answer panel shows: T3 coding tasks and agent `ask_user` questions. */
const CASES: Record<string, Request> = {
	't3-command-approval': {
		requestId: 'r1',
		kind: 'approval',
		title: 'Run command?',
		detail: 'pnpm test:unit -- --run --project server',
		options: [
			{ id: 'accept', label: 'Approve' },
			{ id: 'acceptForSession', label: 'Approve for this session' },
			{ id: 'decline', label: 'Decline' }
		],
		allowFreeText: true,
		createdAt: 0
	},
	't3-file-approval': {
		requestId: 'r2',
		kind: 'approval',
		title: 'Apply changes to 3 files?',
		detail:
			'The agent wants to edit files outside the workspace: src/hooks.server.ts, vite.config.ts and package.json.',
		options: [
			{ id: 'accept', label: 'Approve' },
			{ id: 'decline', label: 'Decline' }
		],
		allowFreeText: true,
		createdAt: 0
	},
	't3-question-options': {
		requestId: 'r3',
		kind: 'question',
		title: 'Which migration strategy should I use?',
		detail: 'Database',
		options: [
			{
				id: 'add',
				label: 'Add a new migration',
				description: 'Keeps applied migrations untouched.'
			},
			{
				id: 'edit',
				label: 'Edit the last migration',
				description: 'Only safe if it was never deployed.'
			}
		],
		allowFreeText: true,
		createdAt: 0
	},
	't3-question-text': {
		requestId: 'r4',
		kind: 'question',
		title: 'What should the new endpoint be called?',
		detail: null,
		options: [],
		allowFreeText: true,
		createdAt: 0
	},
	'agent-confirm': askUserRequest('c1', {
		question: 'I found 14 newsletters older than a month. Archive them?',
		kind: 'confirm',
		recommended: 'approve'
	}).request,
	'agent-choice-descriptions': askUserRequest('c2', {
		question: 'How many people should I plan meals for this week?',
		kind: 'choice',
		options: [
			{ value: '1', label: 'Just me', description: 'Single portions, fewer leftovers.' },
			{ value: '2', label: 'Two people', description: 'What you planned for last week.' },
			{ value: '4', label: 'Family of four', description: 'Bigger batches, more prep on Sunday.' }
		],
		recommended: '2'
	}).request,
	'agent-choice-short': askUserRequest('c3', {
		question: 'Which store should the grocery list be sorted for?',
		kind: 'choice',
		options: [
			{ value: 'aldi', label: 'Aldi' },
			{ value: 'billa', label: 'Billa' },
			{ value: 'spar', label: 'Spar' }
		],
		recommended: 'billa'
	}).request,
	'agent-text': askUserRequest('c4', {
		question:
			'To help you plan your meals for the upcoming week, I need some details: how many people are we planning for, and do you have any dietary preferences or restrictions (vegetarian, vegan, gluten-free, allergies, etc.)?',
		kind: 'text'
	}).request
};

const SHOTS = import.meta.env.VITE_PANEL_SHOTS as string | undefined;

afterEach(() => {
	document.documentElement.classList.remove('dark');
	for (const column of document.querySelectorAll('[data-harness-column]')) column.remove();
});

async function shoot(name: string, el: HTMLElement, width = 800, height = 640) {
	if (!SHOTS) return;
	// The runner scales its iframe down and draws its own panels over parts of it:
	// lift the iframe above everything, full size, for the capture.
	const frame = window.frameElement as HTMLElement | null;
	const host = frame?.parentElement;
	if (host) {
		host.style.transform = 'none';
		host.setAttribute('data-scale', '1');
	}
	if (frame) {
		frame.style.cssText = `position:fixed;top:0;left:0;z-index:2147483647;width:${width}px;height:${height}px;border:0;`;
	}
	await new Promise((r) => setTimeout(r, 150));
	await browserPage.screenshot({ path: `${SHOTS}/${name}.png`, scale: 'css', element: el });
}

/** The panel where ChatView puts it: in the composer column, above the composer. */
function renderInComposer(request: Request, onrespond?: () => Promise<boolean>) {
	// Agent questions answer through the chat (onrespond); T3's go to its endpoint.
	const agent = !request.requestId.startsWith('r');
	const screen = render(CodingPendingRequest, {
		conversationId: 'conv',
		request,
		...(agent ? { onrespond: onrespond ?? (async () => true) } : {})
	});
	const column = document.createElement('div');
	column.dataset.harnessColumn = '';
	column.className = 'mx-auto w-full max-w-3xl bg-background px-4 pt-6 pb-4';
	const composer = document.createElement('div');
	composer.className =
		'flex h-24 items-start rounded-3xl border bg-card px-5 py-4 text-sm text-muted-foreground';
	// The placeholder ChatView shows while the request waits.
	composer.textContent =
		!agent && request.kind === 'approval' ? 'Or decline with a note…' : 'Type your answer…';
	screen.container.parentElement!.insertBefore(column, screen.container);
	column.append(screen.container, composer);
	return { screen, column };
}

const VIEWPORTS = [
	{ name: 'desktop', width: 800, height: 640 },
	{ name: 'mobile', width: 390, height: 640 }
] as const;

describe('CodingPendingRequest', () => {
	it('sends the chosen option through onrespond', async () => {
		const onrespond = vi.fn(async () => true);
		const { screen } = renderInComposer(CASES['agent-choice-short'], onrespond);
		await screen.getByRole('button', { name: 'Billa' }).click();
		expect(onrespond).toHaveBeenCalledWith({ optionId: expect.any(String) });
	});

	it('leaves free-text answers to the composer when answers go out as chat messages', async () => {
		const { screen } = renderInComposer(CASES['agent-text']);
		expect(screen.container.querySelector('textarea')).toBeNull();
		await expect.element(screen.getByRole('heading')).toHaveTextContent(/meals/);
	});

	it('has no reply box of its own: typed answers go through the composer', async () => {
		const { screen } = renderInComposer(CASES['t3-question-options']);
		expect(screen.container.querySelector('textarea')).toBeNull();
		await expect.element(screen.getByText('Or type your own answer below.')).toBeInTheDocument();
	});

	for (const viewport of VIEWPORTS) {
		for (const theme of ['dark', 'light'] as const) {
			for (const [name, request] of Object.entries(CASES)) {
				it(`renders ${name} (${viewport.name}, ${theme})`, async () => {
					await browserPage.viewport(viewport.width, viewport.height);
					if (theme === 'dark') document.documentElement.classList.add('dark');
					document.body.className = 'bg-background text-foreground';
					const { column } = renderInComposer(request);
					expect(column.textContent).toContain(request.title);
					// Park the pointer on the composer so no option shows a hover state.
					await userEvent.hover(column.lastElementChild as HTMLElement);
					await shoot(`${name}-${viewport.name}-${theme}`, column, viewport.width, viewport.height);
				});
			}
		}
	}

	it('locks the panel while an answer is being sent', async () => {
		await browserPage.viewport(800, 640);
		document.documentElement.classList.add('dark');
		document.body.className = 'bg-background text-foreground';
		const { screen, column } = renderInComposer(
			CASES['agent-choice-descriptions'],
			() => new Promise<boolean>(() => {})
		);
		await screen.getByRole('button', { name: /Two people/ }).click();
		await expect
			.element(screen.getByRole('button', { name: /Just me/ }))
			.toHaveAttribute('aria-disabled', 'true');
		// The answer being sent keeps focus.
		expect(document.activeElement?.textContent).toContain('Two people');
		await shoot('busy-desktop-dark', column);
	});
});
