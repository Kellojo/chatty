import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import LinksWidget from './links-widget.svelte';

const payload = JSON.stringify({
	links: [
		{
			url: 'https://developer.mozilla.org/en-US/docs/Web/CSS',
			title: 'CSS container queries - CSS: Cascading Style Sheets | MDN',
			site: 'MDN Web Docs',
			description: 'Cascading Style Sheets is a stylesheet language.',
			favicon: 'data:image/png;base64,AAAA'
		},
		{ url: 'https://www.example.com/post', title: 'Example post' },
		{ url: 'https://www.example.com/post', title: 'Duplicate, dropped' },
		{ url: 'javascript:alert(1)', title: 'Unsafe, dropped' }
	]
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('LinksWidget', () => {
	it('shows a row skeleton while the fence is incomplete', async () => {
		const screen = render(LinksWidget, {
			code: '{"links":[{"url":"https://a.dev"},{"url":"https://',
			isIncomplete: true
		});
		await expect.element(screen.getByText('Gathering sources…')).toBeInTheDocument();
		await expect.element(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
	});

	it('shows the error state for invalid JSON or no usable links', async () => {
		const bad = render(LinksWidget, { code: '{"links": [', isIncomplete: false });
		await expect.element(bad.getByText('Could not render sources')).toBeInTheDocument();
		const unsafe = render(LinksWidget, {
			code: '{"links":[{"url":"javascript:alert(1)","title":"x"}]}',
			isIncomplete: false
		});
		await expect.element(unsafe.getByText('Could not render sources').first()).toBeInTheDocument();
	});

	it('renders numbered cards, drops duplicates and unsafe URLs, and degrades missing fields', async () => {
		const screen = render(LinksWidget, { code: payload, isIncomplete: false });
		await expect.element(screen.getByText('2 sources')).toBeInTheDocument();
		const links = screen.getByRole('link');
		expect(links.elements()).toHaveLength(2);
		// Site suffix and section crumb are stripped from the title; site name, number and summary are shown.
		const mdn = screen.getByRole('link', {
			name: '1. CSS container queries, MDN Web Docs (developer.mozilla.org)'
		});
		await expect
			.element(mdn)
			.toHaveAttribute('href', 'https://developer.mozilla.org/en-US/docs/Web/CSS');
		await expect.element(mdn).toHaveAttribute('rel', 'noopener noreferrer');
		await expect
			.element(mdn)
			.toHaveAccessibleDescription('Cascading Style Sheets is a stylesheet language.');
		// No site name: the hostname stands in, and a monogram replaces the missing favicon.
		await expect
			.element(screen.getByRole('link', { name: '2. Example post, example.com' }))
			.toBeInTheDocument();
		await expect.element(screen.getByText('e', { exact: true })).toBeInTheDocument();
	});

	it('caps the list and says how many sources there were', async () => {
		const links = Array.from({ length: 14 }, (_, i) => ({
			url: `https://site${i}.example/`,
			title: `Page ${i}`
		}));
		const screen = render(LinksWidget, { code: JSON.stringify({ links }), isIncomplete: false });
		await expect.element(screen.getByText('12 of 14 sources')).toBeInTheDocument();
		expect(screen.getByRole('link').elements()).toHaveLength(12);
	});

	it('falls back to a monogram when a favicon fails to load', async () => {
		const screen = render(LinksWidget, { code: payload, isIncomplete: false });
		// The MDN fixture's favicon is a broken image.
		await expect.element(screen.getByText('M', { exact: true })).toBeInTheDocument();
		const img = screen.container.querySelector('img[referrerpolicy="no-referrer"]');
		expect(img).toBeNull();
	});

	it('asks for confirmation before opening an external link', async () => {
		const open = vi.fn();
		vi.stubGlobal('open', open);
		const screen = render(LinksWidget, { code: payload, isIncomplete: false });
		await screen.getByRole('link', { name: /Example post/ }).click();
		await expect.element(page.getByText('Open external link?')).toBeInTheDocument();
		expect(open).not.toHaveBeenCalled();
		await page.getByRole('button', { name: 'Open link' }).click();
		expect(open).toHaveBeenCalledWith('https://www.example.com/post', '_blank', 'noreferrer');
	});
});
