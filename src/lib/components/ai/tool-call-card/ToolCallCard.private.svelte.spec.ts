import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import '../../../../routes/layout.css';
import ToolCallCard from './ToolCallCard.svelte';

const failedPart = (errorText: string) => ({
	type: 'tool-fetch',
	toolCallId: 'call-1',
	state: 'output-error' as const,
	input: { url: 'https://example.com' },
	errorText
});

describe('ToolCallCard blocked in a private chat', () => {
	it('shows a refused egress tool with a lock and a friendly line', async () => {
		const screen = render(ToolCallCard, {
			part: failedPart(
				'[webfetch/fetch] Blocked: this chat contains private data, and `fetch` sends data outside Chatty. Start a new, non-private chat for this.'
			),
			active: false
		});
		await expect
			.element(page.getByText('Blocked in private chats: this tool sends data outside Chatty'))
			.toBeInTheDocument();
		await expect.element(page.getByText('Blocked', { exact: true })).toBeInTheDocument();
		expect(screen.container.textContent).not.toContain('Failed');
		expect(screen.container.querySelector('.text-destructive')).toBeNull();
		expect(screen.container.querySelector('svg.lucide-lock')).not.toBeNull();
	});

	it('keeps other errors as failures', async () => {
		const screen = render(ToolCallCard, {
			part: failedPart('[webfetch/fetch] Request timed out'),
			active: false
		});
		await expect.element(page.getByText('Failed')).toBeInTheDocument();
		expect(screen.container.textContent).not.toContain('Blocked in private chats');
	});
});
