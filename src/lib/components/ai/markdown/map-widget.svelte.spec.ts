import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import MapWidget from './map-widget.svelte';

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
