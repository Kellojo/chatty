import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import Markdown from './markdown.svelte';

const ENV = '7e3851c2-6cdb-4b48-b71a-914be7348099';
const THREAD = '7681b5c9-4dfa-401a-b927-c9848bba69b5';
const PATH = `/t3-thread/${ENV}/${THREAD}`;

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('T3 thread links', () => {
	it('links a bare thread link to Chatty, labelled with the thread title', async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({ conversationId: 'c-1', title: 'Mobile app' })
		);
		vi.stubGlobal('fetch', fetchMock);
		const screen = render(Markdown, { content: `See <t3-thread://v2/${ENV}/${THREAD}>.` });
		const link = screen.getByRole('link', { name: 'Mobile app' });
		await expect.element(link).toHaveAttribute('href', PATH);
		expect(fetchMock).toHaveBeenCalledWith(`/api/coding/threads/${ENV}/${THREAD}`);
	});

	it('keeps the label of a named thread link', async () => {
		vi.stubGlobal('fetch', vi.fn());
		const screen = render(Markdown, {
			content: `See [the other thread](t3-thread://v2/${ENV}/${THREAD}).`
		});
		const link = screen.getByRole('link', { name: 'the other thread' });
		await expect.element(link).toHaveAttribute('href', PATH);
	});
});
