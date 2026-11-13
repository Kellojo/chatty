import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import type { UIMessage } from '$lib/types.js';
import Harness from './test-harness/MessageNavHarness.svelte';

const reply = Array.from({ length: 12 }, (_, i) => `Line ${i + 1} of a long reply.`).join('\n\n');

function convo(n: number): UIMessage[] {
	return Array.from({ length: n }, (_, i) => [
		{ id: `u${i}`, role: 'user', parts: [{ type: 'text', text: `Question ${i + 1}` }] },
		{ id: `a${i}`, role: 'assistant', parts: [{ type: 'text', text: reply }] }
	]).flat() as UIMessage[];
}

const ticks = () => [...document.querySelectorAll<HTMLButtonElement>('[data-nav-id]')];
const current = () => ticks().find((t) => t.getAttribute('aria-current') === 'location');
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

describe('MessageNav', () => {
	it('marks each user message and highlights the one in view', async () => {
		render(Harness, { messages: convo(5) });
		await nextFrame();
		expect(ticks().map((t) => t.dataset.navId)).toEqual(['u0', 'u1', 'u2', 'u3', 'u4']);
		expect(ticks()[0].getAttribute('aria-label')).toBe('Message 1 of 5: Question 1');
		expect(current()?.dataset.navId).toBe('u0');
	});

	it('stays hidden with a single user message', async () => {
		render(Harness, { messages: convo(1) });
		await expect.element(page.getByRole('navigation')).not.toBeInTheDocument();
	});

	it('jumps to a message, keeps its tick active and moves focus there', async () => {
		render(Harness, { messages: convo(5) });
		await page.getByRole('button', { name: /Message 4 of 5/ }).click();
		expect(current()?.dataset.navId).toBe('u3');
		expect((document.activeElement as HTMLElement).dataset.messageId).toBe('u3');
		await expect.poll(() => current()?.dataset.navId, { timeout: 3000 }).toBe('u3');
	});

	it('has one Tab stop and moves between ticks with the arrow keys', async () => {
		render(Harness, { messages: convo(5) });
		await nextFrame();
		expect(ticks().filter((t) => t.tabIndex === 0)).toHaveLength(1);
		ticks()[0].focus();
		await userEvent.keyboard('{ArrowDown}{ArrowDown}');
		expect(document.activeElement).toBe(ticks()[2]);
		await userEvent.keyboard('{End}');
		expect(document.activeElement).toBe(ticks()[4]);
		expect(ticks()[4].tabIndex).toBe(0);
		await userEvent.keyboard('{Home}');
		expect(document.activeElement).toBe(ticks()[0]);
	});

	it('previews the focused message and hides it on Escape', async () => {
		render(Harness, { messages: convo(5) });
		await nextFrame();
		ticks()[1].focus();
		await expect.element(page.getByText('2 of 5')).toBeInTheDocument();
		await userEvent.keyboard('{Escape}');
		await expect.element(page.getByText('2 of 5')).not.toBeInTheDocument();
	});

	it('tracks nothing while hidden by CSS and catches up once shown', async () => {
		const screen = render(Harness, { messages: convo(5), navHidden: true });
		await nextFrame();
		await nextFrame();
		expect(ticks()).toHaveLength(5);
		expect(current()).toBeUndefined();
		await screen.rerender({ messages: convo(5), navHidden: false });
		await expect.poll(() => current()?.dataset.navId).toBe('u0');
	});
});
