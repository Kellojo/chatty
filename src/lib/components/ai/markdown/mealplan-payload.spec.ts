import { describe, expect, it } from 'vitest';
import { addDays, daysBetween, isoDay, parseMealPlan } from './mealplan-payload.js';

const norishItem = (over: Record<string, unknown> = {}) => ({
	id: 'p1',
	date: '2026-11-09',
	slot: 'Snack',
	sortOrder: 0,
	recipeId: 'c39',
	version: 1,
	recipeName: 'Himbeermüsli mit Erdnussbutter',
	recipeImage: '/recipes/c39/x.jpg',
	servings: 1,
	calories: 350,
	...over
});

describe('mealplan-payload', () => {
	it('validates and shifts calendar days', () => {
		expect(isoDay('2026-11-09')).toBe('2026-11-09');
		expect(isoDay('2026-02-30')).toBeNull();
		expect(isoDay('soon')).toBeNull();
		expect(addDays('2026-11-30', 2)).toBe('2026-12-02');
		expect(daysBetween('2026-11-09', '2026-11-15')).toBe(6);
	});

	it('accepts Norish planned items verbatim, dropping relative image paths', () => {
		const plan = parseMealPlan(JSON.stringify([norishItem()]));
		expect(plan?.total).toBe(1);
		expect(plan?.days[0].meals[0]).toMatchObject({
			key: 'p1',
			slot: 'Snack',
			name: 'Himbeermüsli mit Erdnussbutter',
			image: null,
			servings: 1,
			calories: 350
		});
	});

	it('fills empty days of a week and orders meals by slot', () => {
		const plan = parseMealPlan(
			JSON.stringify({
				from: '2026-11-09',
				to: '2026-11-15',
				items: [
					norishItem({ id: 'd', slot: 'dinner' }),
					norishItem({ id: 'b', slot: 'Breakfast' }),
					norishItem({ id: 'out', date: '2026-11-20' })
				]
			})
		);
		expect(plan?.filled).toBe(true);
		expect(plan?.days).toHaveLength(7);
		expect(plan?.days[0].meals.map((m) => m.key)).toEqual(['b', 'd']);
		expect(plan?.days[1].meals).toEqual([]);
		expect(plan?.total).toBe(2);
	});

	it('lists only planned days for longer ranges', () => {
		const plan = parseMealPlan(
			JSON.stringify([norishItem(), norishItem({ id: 'x', date: '2026-11-28' })])
		);
		expect(plan?.filled).toBe(false);
		expect(plan?.days.map((d) => d.date)).toEqual(['2026-11-09', '2026-11-28']);
	});

	it('rejects unusable payloads but keeps an empty explicit range', () => {
		expect(parseMealPlan('nope')).toBeNull();
		expect(parseMealPlan('{"items":"x"}')).toBeNull();
		expect(parseMealPlan(JSON.stringify([{ date: 'x', slot: 'Dinner', name: 'A' }]))).toBeNull();
		const empty = parseMealPlan(
			JSON.stringify({ from: '2026-11-09', to: '2026-11-15', items: [] })
		);
		expect(empty?.total).toBe(0);
	});
});
