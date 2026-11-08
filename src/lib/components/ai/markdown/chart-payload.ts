// The JSON a ```chart block carries, shared by the widget and its lazy chart.

export type ChartType = 'bar' | 'line' | 'area' | 'pie';

export type ChartDataset = {
	label?: string;
	data: number[];
};

export type ChartPayload = {
	type: ChartType;
	title?: string;
	labels: string[];
	datasets: ChartDataset[];
};
