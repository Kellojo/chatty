import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { PRIVATE_CHAT_KEY } from '$lib/private-context.js';

const app = vi.hoisted(() => ({ page: { data: {} as { mapTiles?: 'google' | 'osm' } } }));
vi.mock('$app/state', () => app);

const { default: MapWidget } = await import('./map-widget.svelte');

const code = JSON.stringify({
	title: 'Clinic',
	markers: [{ name: 'Clinic', lat: 38.7223, lng: -9.1393 }]
});

/** Requests this page made to the tile server so far. */
const tileRequests = () =>
	performance
		.getEntriesByType('resource')
		.filter((entry) => entry.name.includes('tile.openstreetmap.org'));

describe('MapWidget in a private chat', () => {
	beforeEach(() => {
		app.page.data = {};
	});

	it('names Google Maps as the source when Google tiles are configured', async () => {
		app.page.data = { mapTiles: 'google' };
		const screen = render(MapWidget, {
			props: { code, isIncomplete: false },
			context: new Map([[PRIVATE_CHAT_KEY, () => true]])
		});
		await expect
			.element(screen.getByText('Private chat: the map loads from Google Maps only when you ask.'))
			.toBeInTheDocument();
	});
	it('loads no tiles until "Show map" is clicked', async () => {
		const screen = render(MapWidget, {
			props: { code, isIncomplete: false },
			context: new Map([[PRIVATE_CHAT_KEY, () => true]])
		});
		const show = screen.getByRole('button', { name: 'Show map' });
		await expect.element(show).toBeInTheDocument();
		// The places list still shows; the map itself waits.
		expect(screen.container.textContent).toContain('Clinic');
		await new Promise((r) => setTimeout(r, 500));
		expect(screen.container.querySelector('.leaflet-container')).toBeNull();
		expect(screen.container.querySelector('img.leaflet-tile')).toBeNull();
		expect(tileRequests()).toEqual([]);

		await show.click();
		await expect
			.poll(() => screen.container.querySelector('img.leaflet-tile'), { timeout: 10000 })
			.not.toBeNull();
		expect(screen.container.querySelector('img.leaflet-tile')?.getAttribute('src')).toContain(
			'tile.openstreetmap.org'
		);
	});

	it('loads place photos only once the map is shown', async () => {
		const withPhoto = JSON.stringify({
			markers: [
				{ name: 'Clinic', lat: 38.7223, lng: -9.1393, photos: [{ url: '/api/maps/photo/abc' }] }
			]
		});
		const screen = render(MapWidget, {
			props: { code: withPhoto, isIncomplete: false },
			context: new Map([[PRIVATE_CHAT_KEY, () => true]])
		});
		const show = screen.getByRole('button', { name: 'Show map' });
		await expect.element(show).toBeInTheDocument();
		expect(screen.container.querySelector('img[src="/api/maps/photo/abc"]')).toBeNull();

		await show.click();
		await expect
			.poll(() => screen.container.querySelector('li img[src="/api/maps/photo/abc"]'))
			.not.toBeNull();
	});

	it('shows the map at once outside a private chat', async () => {
		const screen = render(MapWidget, { code, isIncomplete: false });
		await expect
			.poll(() => screen.container.querySelector('.leaflet-container'), { timeout: 10000 })
			.not.toBeNull();
		expect(screen.container.textContent).not.toContain('Show map');
	});
});
