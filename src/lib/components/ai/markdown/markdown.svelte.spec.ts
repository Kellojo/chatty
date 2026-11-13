import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { setMode } from 'mode-watcher';
import Markdown from './markdown.svelte';

const tokenColors = (container: HTMLElement) =>
	[...container.querySelectorAll<HTMLElement>('[data-streamdown="code-block-body"] code span span')]
		.map((span) => span.style.color)
		.filter(Boolean);

describe('Markdown', () => {
	it('highlights code blocks', async () => {
		const content = '```ts\nconst answer: number = 42;\n```';
		const screen = render(Markdown, { content, streaming: false });
		await expect.poll(() => tokenColors(screen.container).length).toBeGreaterThan(1);
	});

	it('highlights a block that was highlighted before', async () => {
		const content = '```js\nlet reused = "yes";\n```';
		const first = render(Markdown, { content, streaming: false });
		await expect.poll(() => tokenColors(first.container).length).toBeGreaterThan(1);
		const colors = tokenColors(first.container);
		first.unmount();

		const second = render(Markdown, { content, streaming: false });
		await expect.poll(() => tokenColors(second.container)).toEqual(colors);
	});

	it('re-highlights code when the mode changes', async () => {
		setMode('light');
		const content = '```ts\nconst mode = "follows";\n```';
		const screen = render(Markdown, { content, streaming: false });
		await expect.poll(() => tokenColors(screen.container).length).toBeGreaterThan(1);
		const light = tokenColors(screen.container);
		setMode('dark');
		try {
			await expect.poll(() => tokenColors(screen.container)).not.toEqual(light);
			expect(tokenColors(screen.container).length).toBe(light.length);
		} finally {
			setMode('light');
		}
	});

	it('renders math with KaTeX', async () => {
		const screen = render(Markdown, { content: '$$x^2$$', streaming: false });
		await expect.poll(() => screen.container.querySelector('.katex')).not.toBeNull();
	});
});
