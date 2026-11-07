import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import QueuedMessages from './QueuedMessages.svelte';

const items = [
	{ id: 'a', text: 'Also add tests', files: [] },
	{ id: 'b', text: '', files: [new File(['x'], 'notes.md')] }
];

function handlers() {
	return {
		onsendnow: vi.fn(),
		onedit: vi.fn(),
		onremove: vi.fn(),
		onresume: vi.fn()
	};
}

describe('QueuedMessages', () => {
	it('lists queued messages and hands each action the right one', async () => {
		const on = handlers();
		const screen = render(QueuedMessages, { items, busy: true, ...on });
		await expect.element(screen.getByText('2 queued')).toBeInTheDocument();
		await expect.element(screen.getByText('Sends when the reply finishes')).toBeInTheDocument();
		await expect.element(screen.getByText('notes.md')).toBeInTheDocument();

		await screen.getByRole('button', { name: 'Send now' }).first().click();
		expect(on.onsendnow).toHaveBeenCalledWith(items[0]);
		await screen.getByRole('button', { name: 'Edit queued message' }).nth(1).click();
		expect(on.onedit).toHaveBeenCalledWith(items[1]);
		await screen.getByRole('button', { name: 'Remove queued message' }).first().click();
		expect(on.onremove).toHaveBeenCalledWith(items[0]);
	});

	it('offers to resume a paused queue', async () => {
		const on = handlers();
		const screen = render(QueuedMessages, { items, paused: true, busy: false, ...on });
		await expect.element(screen.getByText('Paused')).toBeInTheDocument();
		await screen.getByRole('button', { name: 'Send next' }).click();
		expect(on.onresume).toHaveBeenCalledOnce();
	});
});
