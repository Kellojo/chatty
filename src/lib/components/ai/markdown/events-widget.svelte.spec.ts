import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import EventsWidget from './events-widget.svelte';

const now = Date.parse('2026-11-09T10:00:00Z');
const viewerTimeZone = 'Europe/Berlin';

function renderEvents(payload: unknown) {
	return render(EventsWidget, {
		code: typeof payload === 'string' ? payload : JSON.stringify(payload),
		isIncomplete: false,
		now,
		viewerTimeZone
	});
}

describe('EventsWidget', () => {
	it('shows a loading state while the fence is incomplete', async () => {
		const screen = render(EventsWidget, { code: '{"events":[', isIncomplete: true });
		await expect.element(screen.getByText('Loading events…').first()).toBeInTheDocument();
	});

	it('shows the error state when no event is usable', async () => {
		const screen = renderEvents('[]');
		await expect.element(screen.getByText('Could not render events')).toBeInTheDocument();
	});

	it('renders events with relative day, status, span and ticket link', async () => {
		const screen = renderEvents({
			title: 'Concerts in Berlin',
			events: [
				{ title: 'Jazz Brunch', start: '2026-11-08T11:00', price: '€18' },
				{
					title: 'Moderat',
					start: '2026-11-09T20:00',
					venue: 'Columbiahalle',
					city: 'Berlin',
					status: 'few',
					url: 'https://example.com/moderat'
				},
				{ title: 'Jazzfest', start: '2026-11-13', end: '2026-11-15' }
			]
		});
		await expect.element(screen.getByText('Concerts in Berlin')).toBeInTheDocument();
		await expect.element(screen.getByText('3 events')).toBeInTheDocument();
		await expect.element(screen.getByText('Past')).toBeInTheDocument();
		await expect.element(screen.getByText('Today')).toBeInTheDocument();
		await expect.element(screen.getByText('Few tickets left')).toBeInTheDocument();
		await expect.element(screen.getByText('Columbiahalle, Berlin')).toBeInTheDocument();
		await expect.element(screen.getByText('Nov 13 – 15')).toBeInTheDocument();
		// Past events don't advertise a price.
		expect(screen.getByText('€18').elements()).toHaveLength(0);
		await expect
			.element(
				screen.getByRole('link', { name: 'Tickets for Moderat, opens in a new tab' }).first()
			)
			.toHaveAttribute('href', 'https://example.com/moderat');
	});
});
