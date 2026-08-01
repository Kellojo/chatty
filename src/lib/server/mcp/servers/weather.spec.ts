import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

const { createWeatherServer } = await import('./weather.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { createMCPClient } = await import('@ai-sdk/mcp');

const GEO = {
	results: [
		{
			name: 'Berlin',
			latitude: 52.52,
			longitude: 13.41,
			country: 'Germany',
			admin1: 'Berlin'
		}
	]
};

const FORECAST = {
	timezone: 'Europe/Berlin',
	current: {
		temperature_2m: 18.2,
		apparent_temperature: 16.8,
		relative_humidity_2m: 55,
		precipitation: 0,
		weather_code: 2,
		wind_speed_10m: 14.1,
		wind_direction_10m: 230
	},
	daily: {
		time: ['2026-08-01', '2026-08-02'],
		weather_code: [61, 2],
		temperature_2m_max: [21, 24],
		temperature_2m_min: [12, 13],
		precipitation_sum: [2.3, 0],
		precipitation_probability_max: [70, 10],
		wind_speed_10m_max: [20, 15]
	}
};

function mockFetch(handler: (url: string) => { status?: number; body: unknown }) {
	return vi.fn(async (input: unknown) => {
		const url = String(input);
		const { status = 200, body } = handler(url);
		return new Response(JSON.stringify(body), {
			status,
			headers: { 'content-type': 'application/json' }
		});
	});
}

async function callGetWeather(args: Record<string, unknown>) {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const server = createWeatherServer();
	await server.connect(serverTransport);
	const client = await createMCPClient({ transport: clientTransport, maxRetries: 0 });
	try {
		const tools = await client.tools();
		const tool = tools.get_weather as unknown as {
			execute: (input: unknown, opts: unknown) => Promise<unknown>;
		};
		return await tool.execute(args, { toolCallId: 't1', messages: [] });
	} finally {
		await client.close();
		await server.close();
	}
}

function resultText(res: unknown): string {
	const r = res as { content?: Array<{ type: string; text?: string }> };
	return r.content?.[0]?.text ?? '';
}

const realFetch = globalThis.fetch;

beforeEach(() => {
	vi.stubGlobal(
		'fetch',
		mockFetch((url) => ({ body: url.includes('geocoding') ? GEO : FORECAST }))
	);
});

afterEach(() => {
	vi.stubGlobal('fetch', realFetch);
	vi.restoreAllMocks();
});

describe('weather server', () => {
	it('returns current + daily forecast payload', async () => {
		const res = await callGetWeather({ location: 'Berlin' });
		const payload = JSON.parse(resultText(res));
		expect(payload.location.name).toBe('Berlin');
		expect(payload.location.country).toBe('Germany');
		expect(payload.location.timezone).toBe('Europe/Berlin');
		expect(payload.current.temp).toBe(18.2);
		expect(payload.current.feels).toBe(16.8);
		expect(payload.current.humidity).toBe(55);
		expect(payload.current.wind).toBe(14.1);
		expect(payload.current.windDir).toBe(230);
		expect(payload.current.code).toBe(2);
		expect(payload.units.temp).toBe('°C');
		expect(payload.daily).toHaveLength(2);
		expect(payload.daily[0]).toMatchObject({
			date: '2026-08-01',
			code: 61,
			tmin: 12,
			tmax: 21,
			precipSum: 2.3,
			precipProb: 70,
			windMax: 20
		});
	});

	it('errors when location is not found', async () => {
		vi.stubGlobal(
			'fetch',
			mockFetch(() => ({ body: { results: [] } }))
		);
		const res = await callGetWeather({ location: 'Nowhereville' });
		expect((res as { isError?: boolean }).isError).toBe(true);
		expect(resultText(res)).toContain('location not found');
	});

	it('errors when forecast request fails', async () => {
		vi.stubGlobal(
			'fetch',
			mockFetch((url) => (url.includes('geocoding') ? { body: GEO } : { status: 500, body: {} }))
		);
		const res = await callGetWeather({ location: 'Berlin' });
		expect((res as { isError?: boolean }).isError).toBe(true);
		expect(resultText(res)).toContain('forecast fetch failed');
	});

	it('passes requested forecast days to the API', async () => {
		const spy = mockFetch((url) => ({ body: url.includes('geocoding') ? GEO : FORECAST }));
		vi.stubGlobal('fetch', spy);
		await callGetWeather({ location: 'Berlin', days: 3 });
		const forecastCall = spy.mock.calls
			.map((c) => String(c[0]))
			.find((u) => u.includes('forecast'));
		expect(forecastCall).toBeDefined();
		expect(forecastCall).toContain('forecast_days=3');
	});
});
