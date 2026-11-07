import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ChatsWidget from './chats-widget.svelte';

const payload = JSON.stringify({
	title: 'This week',
	chats: [
		{ id: 'c-1', title: 'Trip to Lisbon', updatedAt: Date.now() - 3600_000, summary: 'Hotels' },
		{
			id: 'c-2',
			title: 'Fix the flaky test',
			updatedAt: Date.now(),
			coding: {
				project: 'kellojo-website',
				status: 'awaiting_input',
				model: 'gpt-5',
				branch: 'fix/flaky',
				pullRequest: 'https://github.com/o/r/pull/42',
				linesAdded: 12,
				linesRemoved: 3,
				waitingFor: { kind: 'question', title: 'Which test runner?' }
			}
		},
		{ title: 'no id, dropped' }
	]
});

describe('ChatsWidget', () => {
	it('shows a loading state while the fence is incomplete', async () => {
		const screen = render(ChatsWidget, { code: '', isIncomplete: true });
		await expect.element(screen.getByText('Loading chats…')).toBeInTheDocument();
	});

	it('shows a fallback for invalid JSON or no chats', async () => {
		const bad = render(ChatsWidget, { code: 'nope', isIncomplete: false });
		await expect.element(bad.getByText('Could not render chats')).toBeInTheDocument();
		const empty = render(ChatsWidget, { code: '{"chats":[]}', isIncomplete: false });
		await expect.element(empty.getByText('Could not render chats').first()).toBeInTheDocument();
	});

	it('renders chats linked to their conversation, with coding details', async () => {
		const screen = render(ChatsWidget, { code: payload, isIncomplete: false });
		await expect.element(screen.getByText('This week')).toBeInTheDocument();
		await expect.element(screen.getByText('2 chats · 1 coding')).toBeInTheDocument();

		const link = screen.getByRole('link', { name: 'Fix the flaky test' });
		await expect.element(link).toHaveAttribute('href', expect.stringMatching(/\/chat\/c-2$/));
		await expect.element(screen.getByText('Waiting for you')).toBeInTheDocument();
		await expect.element(screen.getByText('kellojo-website')).toBeInTheDocument();
		await expect.element(screen.getByText('fix/flaky')).toBeInTheDocument();
		await expect.element(screen.getByText('+12')).toBeInTheDocument();
		await expect.element(screen.getByText('Which test runner?')).toBeInTheDocument();
		await expect
			.element(screen.getByRole('link', { name: 'PR #42' }))
			.toHaveAttribute('href', 'https://github.com/o/r/pull/42');
		await expect.element(screen.getByText('Hotels')).toBeInTheDocument();
		expect(screen.container.textContent).not.toContain('no id, dropped');
	});

	it('accepts a bare array of search results', async () => {
		const screen = render(ChatsWidget, {
			code: JSON.stringify([{ id: 'c-9', title: 'Plain chat', updatedAt: 0 }]),
			isIncomplete: false
		});
		await expect.element(screen.getByText('Plain chat')).toBeInTheDocument();
		await expect.element(screen.getByText('1 chat')).toBeInTheDocument();
	});
});
