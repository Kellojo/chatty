import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import MealplanWidget from './mealplan-widget.svelte';

const now = Date.parse('2026-11-09T10:00:00Z');
const viewerTimeZone = 'Europe/Berlin';

function renderPlan(payload: unknown) {
	return render(MealplanWidget, {
		code: typeof payload === 'string' ? payload : JSON.stringify(payload),
		isIncomplete: false,
		now,
		viewerTimeZone
	});
}

describe('MealplanWidget', () => {
	it('shows a loading state while the fence is incomplete', async () => {
		const screen = render(MealplanWidget, { code: '{"items":[', isIncomplete: true });
		await expect.element(screen.getByText('Loading meal plan…').first()).toBeInTheDocument();
	});

	it('shows the error state for unusable payloads', async () => {
		const screen = renderPlan('{"items":"nope"}');
		await expect.element(screen.getByText('Could not render meal plan')).toBeInTheDocument();
	});

	it('renders a week with meals, empty days and the kcal total', async () => {
		const screen = renderPlan({
			title: 'This week',
			from: '2026-11-09',
			to: '2026-11-15',
			items: [
				{
					date: '2026-11-09',
					slot: 'Dinner',
					recipeName: 'Butter Chicken',
					servings: 4,
					calories: 700
				},
				{ date: '2026-11-10', slot: 'Lunch', name: 'Bauernsalat', calories: 410 }
			]
		});
		await expect.element(screen.getByText('This week')).toBeInTheDocument();
		await expect.element(screen.getByText('2 meals · 1,110 kcal')).toBeInTheDocument();
		await expect.element(screen.getByText('Butter Chicken')).toBeInTheDocument();
		await expect.element(screen.getByText(/Monday, November 9, Today/)).toBeInTheDocument();
		expect(screen.getByText('Nothing planned', { exact: true }).elements()).toHaveLength(5);
	});

	it('says so when nothing is planned', async () => {
		const screen = renderPlan({ from: '2026-11-09', to: '2026-11-15', items: [] });
		await expect.element(screen.getByText('Nothing planned yet.')).toBeInTheDocument();
	});
});
