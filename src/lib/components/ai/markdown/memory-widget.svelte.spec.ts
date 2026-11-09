import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import MemoryWidget from './memory-widget.svelte';

const single = JSON.stringify({
	items: [
		{
			action: 'created',
			path: 'people/maria.md',
			scope: 'user',
			title: 'Maria Lopez',
			snippet: 'Your sister; lives in Valencia.'
		}
	]
});

const multi = JSON.stringify({
	items: [
		{ action: 'created', path: 'people/maria.md', title: 'Maria Lopez' },
		{ action: 'updated', path: 'preferences/coffee.md', title: 'Coffee order' },
		{ action: 'deleted', path: 'projects/old-site.md', scope: 'shared' },
		{ action: 'created', title: 'no path, dropped' }
	]
});

describe('MemoryWidget', () => {
	it('shows a loading state while the fence is incomplete', async () => {
		const screen = render(MemoryWidget, { code: '{"items":[', isIncomplete: true });
		await expect.element(screen.getByText('Saving to memory…')).toBeInTheDocument();
	});

	it('shows a fallback for invalid JSON or no usable items', async () => {
		const bad = render(MemoryWidget, { code: 'nope', isIncomplete: false });
		await expect.element(bad.getByText('Could not show this memory')).toBeInTheDocument();
		const empty = render(MemoryWidget, { code: '{"items":[]}', isIncomplete: false });
		await expect.element(empty.getByText('Could not show this memory').first()).toBeInTheDocument();
	});

	it('renders a single write with a link to the memory page', async () => {
		const screen = render(MemoryWidget, { code: single, isIncomplete: false });
		await expect.element(screen.getByText('Remembered')).toBeInTheDocument();
		await expect.element(screen.getByText('Maria Lopez')).toBeInTheDocument();
		await expect.element(screen.getByText('Your sister; lives in Valencia.')).toBeInTheDocument();
		const link = screen.getByRole('link', { name: 'Open memory page' });
		await expect.element(link).toHaveAttribute('href', expect.stringMatching(/\/memory$/));
	});

	it('accepts a bare item and shares one card for several writes', async () => {
		const bare = render(MemoryWidget, {
			code: JSON.stringify({ action: 'updated', path: 'people/jane-doe.md' }),
			isIncomplete: false
		});
		await expect.element(bare.getByText('Jane Doe')).toBeInTheDocument();

		const screen = render(MemoryWidget, { code: multi, isIncomplete: false });
		await expect.element(screen.getByText('Forgot', { exact: true })).toBeInTheDocument();
		expect(screen.container.querySelectorAll('li')).toHaveLength(3);
		await expect.element(screen.getByText('Old Site')).toBeInTheDocument();
		await expect
			.element(screen.getByText('1 remembered · 1 updated · 1 forgotten'))
			.toBeInTheDocument();
		await expect.element(screen.getByText('Shared', { exact: true }).first()).toBeInTheDocument();
	});

	it('says "View memory" when every write was a delete', async () => {
		const screen = render(MemoryWidget, {
			code: JSON.stringify({ items: [{ action: 'deleted', path: 'projects/old-site.md' }] }),
			isIncomplete: false
		});
		await expect.element(screen.getByText('Forgot', { exact: true })).toBeInTheDocument();
		await expect
			.element(screen.getByRole('link', { name: 'View memory page' }))
			.toBeInTheDocument();
	});
});
