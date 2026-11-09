import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ClockWidget from './clock-widget.svelte';
import { dayDelta, formatDiff, formatOffset, phaseOf, zoneTime } from './clock-time.js';

const viewerTimeZone = 'Europe/Berlin';

function renderClock(payload: unknown) {
	return render(ClockWidget, {
		code: typeof payload === 'string' ? payload : JSON.stringify(payload),
		isIncomplete: false,
		viewerTimeZone
	});
}

describe('clock-time', () => {
	it('computes offsets, including half-hour zones', () => {
		const at = Date.parse('2026-11-09T14:30:00Z');
		expect(zoneTime(at, 'Asia/Kolkata')).toMatchObject({ hour: 20, minute: 0, offset: 330 });
		expect(zoneTime(at, 'America/Los_Angeles')).toMatchObject({ hour: 6, offset: -480 });
		expect(zoneTime(at, 'Mars/Olympus')).toBeNull();
		expect(formatOffset(330)).toBe('UTC+5:30');
		expect(formatOffset(-480)).toBe('UTC−8');
		expect(formatOffset(0)).toBe('UTC+0');
		expect(formatDiff(270)).toBe('+4h 30m');
		expect(formatDiff(-60)).toBe('−1h');
		expect(dayDelta('2026-11-09', '2026-11-10')).toBe(1);
		expect(phaseOf(6, 30)).toBe('dawn');
		expect(phaseOf(12)).toBe('day');
		expect(phaseOf(18)).toBe('dusk');
		expect(phaseOf(23)).toBe('night');
	});
});

describe('ClockWidget', () => {
	it('shows a loading state while the fence is incomplete', async () => {
		const screen = render(ClockWidget, { code: '{"zones":[', isIncomplete: true });
		await expect.element(screen.getByText('Loading clock…')).toBeInTheDocument();
	});

	it('shows the error state for invalid JSON, no zones or a bad instant', async () => {
		const bad = renderClock('nope');
		await expect.element(bad.getByText('Could not render clock')).toBeInTheDocument();
		const empty = renderClock({ zones: [] });
		await expect.element(empty.getByText('Could not render clock').first()).toBeInTheDocument();
		const badAt = renderClock({ at: 'whenever', zones: ['Asia/Tokyo'] });
		await expect.element(badAt.getByText('Could not render clock').first()).toBeInTheDocument();
	});

	it('renders one city with its offset and difference from the viewer', async () => {
		const screen = renderClock({
			at: '2026-11-09T05:30:00Z',
			zones: [{ label: 'Tokyo', tz: 'Asia/Tokyo' }]
		});
		await expect.element(screen.getByText('Time in Tokyo')).toBeInTheDocument();
		await expect.element(screen.getByText('UTC+9')).toBeInTheDocument();
		await expect.element(screen.getByText('+8h from you')).toBeInTheDocument();
		await expect.element(screen.getByRole('group', { name: /^Tokyo: 2:30/ })).toBeInTheDocument();
	});

	it('renders a conversion relative to the source city', async () => {
		const screen = renderClock({
			at: '2026-11-09T23:00:00Z',
			convert: true,
			zones: [
				{ label: 'Los Angeles', tz: 'America/Los_Angeles' },
				{ label: 'Berlin', tz: 'Europe/Berlin' }
			]
		});
		await expect.element(screen.getByText('Time conversion')).toBeInTheDocument();
		await expect.element(screen.getByText(/Los Angeles → Berlin/)).toBeInTheDocument();
		await expect.element(screen.getByText('Next day')).toBeInTheDocument();
		await expect
			.element(screen.getByRole('group', { name: /Berlin: 12:00.*\+9h from Los Angeles/ }))
			.toBeInTheDocument();
	});

	it('falls back to a world clock when the conversion source is unknown', async () => {
		const screen = renderClock({
			at: '2026-11-09T23:00:00Z',
			convert: true,
			zones: [
				{ label: 'Mars', tz: 'Mars/Olympus' },
				{ label: 'Berlin', tz: 'Europe/Berlin' }
			]
		});
		await expect.element(screen.getByText('World clock')).toBeInTheDocument();
		await expect.element(screen.getByText('Your time zone')).toBeInTheDocument();
	});

	it('degrades an unknown zone per row and shows live mode', async () => {
		const screen = renderClock({
			zones: [
				{ label: 'London', tz: 'Europe/London' },
				{ label: 'Mars', tz: 'Mars/Olympus' }
			]
		});
		await expect.element(screen.getByText('Unknown time zone “Mars/Olympus”')).toBeInTheDocument();
		await expect.element(screen.getByText('Live')).toBeInTheDocument();
		await expect.element(screen.getByText('London')).toBeInTheDocument();
	});
});
