import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import '../../../routes/layout.css';
import ChatImage from './ChatImage.svelte';

/** A plain landscape image, bigger than the chat frame so it is scaled down to fit. */
function makeImage(w = 1200, h = 800): string {
	const canvas = document.createElement('canvas');
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext('2d')!;
	ctx.fillStyle = '#3b82f6';
	ctx.fillRect(0, 0, w, h);
	return canvas.toDataURL('image/png');
}

const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

/** Rendered sizes of `get()` on every frame for `ms`, skipping frames where it is absent. */
async function sample(get: () => Element | null | undefined, ms: number): Promise<string[]> {
	const sizes: string[] = [];
	const end = performance.now() + ms;
	while (performance.now() < end) {
		const el = get();
		if (el) {
			const r = el.getBoundingClientRect();
			sizes.push(`${Math.round(r.width)}x${Math.round(r.height)}`);
		}
		await frame();
	}
	return sizes;
}

/** Waits until `ok()` holds, checking every frame. */
async function until(ok: () => boolean, ms = 3000) {
	const end = performance.now() + ms;
	while (!ok()) {
		if (performance.now() > end) throw new Error('timed out');
		await frame();
	}
}

const distinct = (xs: string[]) => [...new Set(xs)];

describe('ChatImage', () => {
	it('shows a loaded image at its fitted size at once, without growing in', async () => {
		await page.viewport(1024, 768);
		const { container } = render(ChatImage, { src: makeImage(), filename: 'photo.png' });
		const img = () => container.querySelector('img');
		// The frame is sized (inline width) once the fit is known; from then on it must not move.
		const fitted = () => {
			const el = img();
			return el?.style.width ? el : null;
		};
		await until(() => fitted() !== null);
		const sizes = await sample(fitted, 400);
		expect(distinct(sizes)).toEqual(['448x299']);
	});

	it('still animates a rotation', async () => {
		await page.viewport(1024, 768);
		const { container } = render(ChatImage, { src: makeImage(), filename: 'photo.png' });
		await until(() => !!container.querySelector('img')?.style.width);
		await sample(() => null, 100);
		const box = () => container.querySelector('img')!.parentElement!.parentElement;
		await page.getByRole('button', { name: 'Rotate right' }).click();
		const sizes = await sample(box, 400);
		// The frame eases from landscape to portrait over several frames.
		expect(distinct(sizes).length).toBeGreaterThan(2);
		expect(sizes.at(-1)).toBe('256x384');
	});

	it('opens the viewer with the image already fitted, without shrinking in', async () => {
		await page.viewport(1024, 768);
		render(ChatImage, { src: makeImage(), filename: 'photo.png' });
		await page.getByRole('button', { name: 'View photo.png full size' }).click();
		const viewerImg = () =>
			document.querySelector<HTMLImageElement>('[role="dialog"] img:not(.opacity-0)');
		await until(() => viewerImg() !== null);
		const sizes = await sample(viewerImg, 400);
		expect(distinct(sizes)).toHaveLength(1);
	});

	it('reopens the viewer without animating, after a close and a window resize', async () => {
		await page.viewport(1024, 768);
		render(ChatImage, { src: makeImage(), filename: 'photo.png' });
		const viewerImg = () =>
			document.querySelector<HTMLImageElement>('[role="dialog"] img:not(.opacity-0)');
		await page.getByRole('button', { name: 'View photo.png full size' }).click();
		await until(() => viewerImg() !== null);
		await page.getByRole('button', { name: 'Close', exact: true }).click();
		await until(() => !document.querySelector('[role="dialog"]'));
		// A different stage size leaves the last fit stale until the stage re-measures.
		await page.viewport(800, 600);
		await page.getByRole('button', { name: 'View photo.png full size' }).click();
		await until(() => viewerImg() !== null);
		const sizes = await sample(viewerImg, 400);
		expect(distinct(sizes)).toHaveLength(1);
	});
});
