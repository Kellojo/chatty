import { describe, expect, it } from 'vitest';
import { parseEvents, parseMoment } from './events-payload.js';

describe('events-payload', () => {
	it('keeps wall-clock times and converts instants into the given zone', () => {
		expect(parseMoment('2026-11-14')).toEqual({ date: '2026-11-14', time: null });
		expect(parseMoment('2026-11-14T20:00')).toEqual({ date: '2026-11-14', time: '20:00' });
		expect(parseMoment('2026-11-14T23:30:00Z', 'Europe/Berlin')).toEqual({
			date: '2026-11-15',
			time: '00:30'
		});
		expect(parseMoment('tomorrow')).toBeNull();
	});

	it('normalizes fields, status and lineup, and sorts by start', () => {
		const list = parseEvents(
			JSON.stringify({
				title: 'Concerts',
				events: [
					{ title: 'B', start: '2026-12-03T20:00', status: 'Sold Out', url: 'javascript:alert(1)' },
					{
						name: 'A',
						date: '2026-11-09',
						time: '20:00',
						venue: { name: 'Columbiahalle', city: 'Berlin' },
						lineup: 'Modeselektor, Apparat',
						price: 'Free',
						url: 'https://example.com/a'
					}
				]
			})
		);
		expect(list?.events.map((e) => e.title)).toEqual(['A', 'B']);
		expect(list?.events[0]).toMatchObject({
			start: { date: '2026-11-09', time: '20:00' },
			venue: 'Columbiahalle',
			city: 'Berlin',
			lineup: ['Modeselektor', 'Apparat'],
			status: 'free',
			url: 'https://example.com/a'
		});
		expect(list?.events[1]).toMatchObject({ status: 'soldout', url: null });
		expect(list?.months.map((m) => m.key)).toEqual(['2026-11', '2026-12']);
	});

	it('drops ends that are not after the start', () => {
		const list = parseEvents(
			JSON.stringify([{ title: 'X', start: '2026-11-10T20:00', end: '2026-11-09' }])
		);
		expect(list?.events[0].end).toBeNull();
	});

	it('rejects payloads without a usable event', () => {
		expect(parseEvents('nope')).toBeNull();
		expect(parseEvents('[]')).toBeNull();
		expect(parseEvents(JSON.stringify([{ title: 'No date' }]))).toBeNull();
	});
});
