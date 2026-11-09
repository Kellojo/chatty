import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import CalcWidget from './calc-widget.svelte';
import {
	formatNumber,
	formatScaled,
	parseCalc,
	prettyExpression,
	prettyUnit
} from './calc-payload';

const json = (v: unknown) => JSON.stringify(v);

describe('CalcWidget', () => {
	it('shows a loading state while the fence is incomplete', async () => {
		const screen = render(CalcWidget, { code: '{"kind":"calc', isIncomplete: true });
		await expect.element(screen.getByText('Calculating…')).toBeInTheDocument();
	});

	it('shows the error state with raw data for invalid payloads', async () => {
		const screen = render(CalcWidget, { code: 'not json {', isIncomplete: false });
		await expect.element(screen.getByText('Could not render this result')).toBeInTheDocument();
		const bad = render(CalcWidget, {
			code: json({ kind: 'convert', to: [] }),
			isIncomplete: false
		});
		await expect.element(bad.getByText('Could not render this result').first()).toBeInTheDocument();
	});

	it('renders a calculation with the expression and a big result', async () => {
		const screen = render(CalcWidget, {
			code: json({ kind: 'calculate', expression: '1000 * 3 - 1', result: 2999 }),
			isIncomplete: false
		});
		await expect.element(screen.getByText('Calculation')).toBeInTheDocument();
		await expect.element(screen.getByText('1000 × 3 − 1')).toBeInTheDocument();
		await expect.element(screen.getByText('2,999', { exact: true }).first()).toBeInTheDocument();
		await expect.element(screen.getByRole('button', { name: 'Copy result' })).toBeInTheDocument();
	});

	it('renders a conversion with extra targets as tiles', async () => {
		const screen = render(CalcWidget, {
			code: json({
				kind: 'convert',
				measure: 'length',
				from: { value: 12.4, unit: 'km', name: 'kilometers' },
				to: [
					{ value: 7.70505181, unit: 'mi', name: 'miles' },
					{ value: 12400, unit: 'm', name: 'meters' }
				]
			}),
			isIncomplete: false
		});
		await expect.element(screen.getByText('Length conversion')).toBeInTheDocument();
		await expect.element(screen.getByText('7.705').first()).toBeInTheDocument();
		await expect.element(screen.getByText('12,400 m')).toBeInTheDocument();
		await expect.element(screen.getByRole('list', { name: 'Other units' })).toBeInTheDocument();
	});

	it('renders statistics with summary tiles, and a note for a single value', async () => {
		const screen = render(CalcWidget, {
			code: json({
				kind: 'statistics',
				count: 4,
				sum: 10,
				mean: 2.5,
				median: 2.5,
				q1: 1.75,
				q3: 3.25,
				min: 1,
				max: 4,
				variance: 1.25,
				stdev: 1.118033988,
				sample: false,
				values: [1, 2, 3, 4]
			}),
			isIncomplete: false
		});
		await expect.element(screen.getByText('Statistics · 4 values')).toBeInTheDocument();
		await expect.element(screen.getByText('Median', { exact: true })).toBeInTheDocument();
		await expect.element(screen.getByText('IQR', { exact: true })).toBeInTheDocument();
		await expect.element(screen.getByRole('button', { name: 'Copy summary' })).toBeInTheDocument();

		const one = render(CalcWidget, {
			code: json({ kind: 'statistics', count: 1, mean: 42, min: 42, max: 42, values: [42] }),
			isIncomplete: false
		});
		await expect
			.element(one.getByText('Spread and distribution need at least two values.'))
			.toBeInTheDocument();
	});
});

describe('calc formatting', () => {
	it('formats numbers, units and expressions for display', () => {
		expect(formatNumber(-1234.5).text).toBe('−1,234.5');
		expect(formatNumber(3.97289e-19).sci?.power).toBe('−19');
		expect(formatNumber(2e20).text).toContain('× 10');
		expect(formatScaled(150.9112, 192.3)).toBe('150.91');
		expect(prettyUnit('C')).toBe('°C');
		expect(prettyUnit('m2')).toBe('m²');
		expect(prettyExpression('2**3 / 4 - 1e-3')).toBe('2^3 ÷ 4 − 1×10⁻³');
		expect(parseCalc('{"result": 3}')).toEqual({ kind: 'calculate', expression: '', result: 3 });
	});
});
