import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ChartWidget from './chart-widget.svelte';

const barPayload = JSON.stringify({
	type: 'bar',
	title: 'Monthly revenue',
	labels: ['Jan', 'Feb', 'Mar'],
	datasets: [{ label: 'Revenue', data: [10, 20, 15] }]
});

const multiBarPayload = JSON.stringify({
	type: 'bar',
	labels: ['Jan', 'Feb'],
	datasets: [
		{ label: 'Revenue', data: [10, 20] },
		{ label: 'Cost', data: [5, 8] }
	]
});

const piePayload = JSON.stringify({
	type: 'pie',
	labels: ['Chrome', 'Safari', 'Firefox'],
	datasets: [{ data: [275, 200, 187] }]
});

describe('ChartWidget', () => {
	it('shows a loading skeleton while the fence is incomplete', async () => {
		const screen = render(ChartWidget, { code: '', isIncomplete: true });
		await expect.element(screen.getByText('Loading chart…')).toBeInTheDocument();
	});

	it('shows a fallback message for invalid JSON', async () => {
		const screen = render(ChartWidget, { code: 'not json', isIncomplete: false });
		await expect.element(screen.getByText('Could not render chart')).toBeInTheDocument();
	});

	it('shows a fallback message for an unsupported chart type', async () => {
		const screen = render(ChartWidget, {
			code: JSON.stringify({ type: 'scatter', labels: ['a'], datasets: [{ data: [1] }] }),
			isIncomplete: false
		});
		await expect.element(screen.getByText('Could not render chart')).toBeInTheDocument();
	});

	it('renders a bar chart with title', async () => {
		const { container } = render(ChartWidget, { code: barPayload, isIncomplete: false });
		const svg = container.querySelector('svg');
		await expect.element(svg).toBeInTheDocument();
		expect(container.textContent).toContain('Monthly revenue');
		const bars = container.querySelectorAll('.lc-bars');
		expect(bars.length).toBe(1);
	});

	it('renders one bar group per dataset for multi-series bar charts', async () => {
		const { container } = render(ChartWidget, { code: multiBarPayload, isIncomplete: false });
		const svg = container.querySelector('svg');
		await expect.element(svg).toBeInTheDocument();
		const bars = container.querySelectorAll('.lc-bars');
		expect(bars.length).toBe(2);
	});

	it('renders a pie chart with one arc per label', async () => {
		const { container } = render(ChartWidget, { code: piePayload, isIncomplete: false });
		const svg = container.querySelector('svg');
		await expect.element(svg).toBeInTheDocument();
		const arcs = container.querySelectorAll('.lc-arc-line');
		expect(arcs.length).toBe(3);
	});

	it('renders a line chart', async () => {
		const linePayload = JSON.stringify({
			type: 'line',
			labels: ['a', 'b', 'c'],
			datasets: [{ label: 'Visits', data: [1, 5, 3] }]
		});
		const { container } = render(ChartWidget, { code: linePayload, isIncomplete: false });
		const svg = container.querySelector('svg');
		await expect.element(svg).toBeInTheDocument();
	});
});
