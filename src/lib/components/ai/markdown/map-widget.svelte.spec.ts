import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';

const app = vi.hoisted(() => ({ page: { data: {} as { mapTiles?: 'google' | 'osm' } } }));
vi.mock('$app/state', () => app);

const { default: MapWidget } = await import('./map-widget.svelte');

const richPlace = JSON.stringify({
	markers: [
		{
			name: 'Café <Rico>',
			lat: 38.7107,
			lng: -9.1424,
			openNow: true,
			summary: 'Historic café',
			photos: [
				{ url: 'https://evil.example/track.png', author: 'Tracker' },
				{ url: '/api/maps/photo/abc_DEF-123', author: 'Ana', authorUrl: 'javascript:alert(1)' }
			],
			reviews: [
				{
					author: 'Marta',
					authorUrl: 'https://maps.google.com/contrib/1',
					rating: 4,
					when: '2 months ago',
					text: 'Great <b>pastries</b>'
				},
				{ author: 'Rui', text: 'Busy at noon' },
				{ author: 'Third', text: 'Not shown' },
				{ author: 'No text' }
			]
		}
	]
});

const mapReady = (container: HTMLElement) =>
	expect.poll(() => container.querySelector('img.leaflet-tile'), { timeout: 10000 }).not.toBeNull();

const twoMarkers = JSON.stringify({
	title: 'Restaurants near Lisbon',
	markers: [
		{
			name: 'Tasca A',
			lat: 38.7223,
			lng: -9.1393,
			address: 'Rua do Comércio 12',
			rating: 4.5,
			website: 'https://tascas.pt'
		},
		{
			name: 'Tasca B',
			lat: 38.7071,
			lng: -9.1466,
			address: 'Av. da Liberdade 100',
			phone: '+351 21 000 0000'
		}
	]
});

describe('MapWidget', () => {
	beforeEach(() => {
		app.page.data = {};
	});

	it('keeps only same-origin photos and shows the opening hint in the list', async () => {
		const { container } = render(MapWidget, { code: richPlace, isIncomplete: false });
		await mapReady(container);
		const thumbs = [...container.querySelectorAll('li img')];
		expect(thumbs.map((img) => img.getAttribute('src'))).toEqual(['/api/maps/photo/abc_DEF-123']);
		expect(container.querySelector('img[src^="https://evil"]')).toBeNull();
		expect(container.textContent).toContain('Open now');
	});

	it('shows the photo, summary and two escaped reviews in the popup', async () => {
		const { container } = render(MapWidget, { code: richPlace, isIncomplete: false });
		await mapReady(container);
		container.querySelector<HTMLButtonElement>('li button')?.click();
		await expect
			.poll(() => container.querySelector('.leaflet-popup-content'), { timeout: 5000 })
			.not.toBeNull();
		const popup = container.querySelector('.leaflet-popup-content')!;
		expect(popup.querySelector('strong')?.textContent).toBe('Café <Rico>');
		expect(popup.textContent).toContain('Historic café');
		const photo = popup.querySelector('.map-widget-photo img');
		expect(photo?.getAttribute('src')).toBe('/api/maps/photo/abc_DEF-123');
		expect(photo?.getAttribute('alt')).toBe('Photo of Café <Rico>');
		// The author link was not https, so the credit is plain text.
		expect(popup.querySelector('figcaption')?.textContent).toBe('Photo: Ana');
		expect(popup.querySelector('figcaption a')).toBeNull();
		const reviews = [...popup.querySelectorAll('.map-widget-reviews li')];
		expect(reviews).toHaveLength(2);
		expect(reviews[0].querySelector('b')).toBeNull();
		expect(reviews[0].textContent).toContain('Great <b>pastries</b>');
		expect(reviews[0].textContent).toContain('★ 4 — Marta · 2 months ago');
		expect(reviews[0].querySelector('a')?.getAttribute('href')).toBe(
			'https://maps.google.com/contrib/1'
		);
		expect(reviews[1].textContent).toContain('— Rui');
		expect(popup.textContent).not.toContain('Not shown');
	});

	it('loads Google tiles through the server when Google is configured', async () => {
		app.page.data = { mapTiles: 'google' };
		const { container } = render(MapWidget, { code: twoMarkers, isIncomplete: false });
		await mapReady(container);
		expect(container.querySelector('img.leaflet-tile')?.getAttribute('src')).toMatch(
			/^\/api\/maps\/tiles\/\d+\/\d+\/\d+$/
		);
		// No attribution endpoint in tests, so it falls back to "Google".
		expect(container.querySelector('.leaflet-control-attribution')?.textContent).toContain(
			'Google'
		);
		expect(container.textContent).not.toContain('OpenStreetMap');
		const logo = container.querySelector('.leaflet-bottom.leaflet-left img.map-widget-google-logo');
		expect(logo?.getAttribute('alt')).toBe('Google Maps');
		expect(logo?.getAttribute('src')).toMatch(/google-maps-logo/);
	});

	it('keeps OpenStreetMap tiles without Google', async () => {
		const { container } = render(MapWidget, { code: twoMarkers, isIncomplete: false });
		await mapReady(container);
		expect(container.querySelector('.map-widget-google-logo')).toBeNull();
		expect(container.querySelector('img.leaflet-tile')?.getAttribute('src')).toContain(
			'tile.openstreetmap.org'
		);
		expect(container.textContent).toContain('OpenStreetMap');
	});
	it('shows a loading skeleton while the fence is incomplete', async () => {
		const screen = render(MapWidget, { code: '', isIncomplete: true });
		await expect.element(screen.getByText('Loading map…')).toBeInTheDocument();
	});

	it('shows a fallback message for invalid JSON', async () => {
		const screen = render(MapWidget, { code: 'not json', isIncomplete: false });
		await expect.element(screen.getByText('Could not render map')).toBeInTheDocument();
	});

	it('shows a fallback message when there are no markers', async () => {
		const screen = render(MapWidget, {
			code: JSON.stringify({ title: 'Empty', markers: [] }),
			isIncomplete: false
		});
		await expect.element(screen.getByText('Could not render map')).toBeInTheDocument();
	});

	it('shows a fallback message for markers without numeric coordinates', async () => {
		const screen = render(MapWidget, {
			code: JSON.stringify({ markers: [{ name: 'X', lat: 'north', lng: 1 }] }),
			isIncomplete: false
		});
		await expect.element(screen.getByText('Could not render map')).toBeInTheDocument();
	});

	it('renders a leaflet map with a list entry per marker', async () => {
		const { container } = render(MapWidget, { code: twoMarkers, isIncomplete: false });
		// Leaflet injects the map div after the async `import('leaflet')`
		// resolves, so poll for it instead of querying once (which yields `null`).
		await expect
			.poll(() => container.querySelector('.leaflet-container'), { timeout: 10000 })
			.not.toBeNull();
		expect(container.textContent).toContain('Restaurants near Lisbon');
		expect(container.textContent).toContain('2 places');
		const buttons = container.querySelectorAll('li button');
		expect(buttons.length).toBe(2);
		expect(container.textContent).toContain('Tasca A');
		expect(container.textContent).toContain('Tasca B');
		expect(container.textContent).toContain('Rua do Comércio 12');
	});
});
