import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { buildLiveActivity } from '$lib/dev/design-playground.js';
import ActivityGroup from './ActivityGroup.svelte';

const items = buildLiveActivity().map((part, index) => ({ part: part as never, index }));

describe('ActivityGroup', () => {
	it('shows only the latest steps while live, with the rest one click away', async () => {
		const screen = render(ActivityGroup, { items, live: true, active: true });
		await expect.element(screen.getByText('Show 3 earlier steps')).toBeInTheDocument();
		await expect.element(screen.getByText('pnpm test:unit -- --run')).toBeInTheDocument();
		await expect.element(screen.getByText('git status --short')).not.toBeInTheDocument();

		await screen.getByText('Show 3 earlier steps').click();
		await expect.element(screen.getByText('git status --short')).toBeInTheDocument();
	});

	it('collapses a finished run into one summary row', async () => {
		const screen = render(ActivityGroup, { items, live: false, active: false });
		const header = screen.getByRole('button', {
			name: /^Edited a file, ran 4 commands and 2 more, 7 steps/
		});
		await expect.element(header).toHaveAttribute('aria-expanded', 'false');
		await expect.element(screen.getByText('git status --short')).not.toBeInTheDocument();

		await header.click();
		await expect.element(screen.getByText('git status --short')).toBeInTheDocument();
		// The unfinished last call of a stopped run is marked, not left spinning.
		await expect.element(screen.getByText('Stopped')).toBeInTheDocument();
	});

	it('times a live thought and labels a finished one with its duration', async () => {
		const tool = items[1];
		const thought = (text: string, t3?: { startedAt: number; completedAt: number }) =>
			({ type: 'reasoning', text, ...(t3 ? { providerMetadata: { t3 } } : {}) }) as never;
		const liveItems = [
			{ part: thought('Planning', { startedAt: 0, completedAt: 12_000 }), index: 0 },
			tool,
			{ part: thought('Still deciding'), index: 5 }
		];
		const screen = render(ActivityGroup, { items: liveItems, live: true, active: true });
		await expect.element(screen.getByText('Thought for 12s')).toBeInTheDocument();
		await expect.element(screen.getByText(/^Thinking\s*\d+s$/)).toBeInTheDocument();
	});
});
