import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { err, text } from './shared.js';

const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const TIMEOUT_MS = 15000;
const MAX_DAYS = 16;

interface GeoResult {
	name: string;
	latitude: number;
	longitude: number;
	country?: string;
	admin1?: string;
}

interface GeoResponse {
	results?: GeoResult[];
}

interface ForecastResponse {
	timezone?: string;
	current?: {
		temperature_2m?: number;
		apparent_temperature?: number;
		relative_humidity_2m?: number;
		precipitation?: number;
		weather_code?: number;
		wind_speed_10m?: number;
		wind_direction_10m?: number;
	};
	daily?: {
		time?: string[];
		weather_code?: number[];
		temperature_2m_max?: number[];
		temperature_2m_min?: number[];
		precipitation_sum?: number[];
		precipitation_probability_max?: number[];
		wind_speed_10m_max?: number[];
	};
}

async function fetchJson(url: string): Promise<unknown> {
	const res = await fetch(url, {
		headers: { 'user-agent': 'ai-chat/0.1 (+https://localhost)' },
		signal: AbortSignal.timeout(TIMEOUT_MS)
	});
	if (!res.ok) {
		throw new Error(`request failed with status ${res.status}`);
	}
	return res.json();
}

async function geocode(location: string): Promise<GeoResult | null> {
	const url = `${GEO_URL}?name=${encodeURIComponent(location)}&count=1&language=en&format=json`;
	const data = (await fetchJson(url)) as GeoResponse;
	return data.results?.[0] ?? null;
}

export function createWeatherServer(): McpServer {
	const server = new McpServer({ name: 'ai-chat-weather', version: '0.1.0' });

	server.registerTool(
		'get_weather',
		{
			description:
				'Get current weather and daily forecast for a location. Returns a JSON payload. ' +
				'To display a weather widget in chat, reply with a ```weather fenced code block ' +
				'containing this JSON verbatim (no extra text inside the fence).',
			inputSchema: {
				location: z.string().describe('City or place name, e.g. "Berlin" or "Paris, FR"'),
				days: z
					.number()
					.int()
					.min(1)
					.max(MAX_DAYS)
					.optional()
					.describe('Number of forecast days (1-16), default 7')
			}
		},
		async ({ location, days }) => {
			const forecastDays = days ?? 7;
			let geo: GeoResult | null;
			try {
				geo = await geocode(location);
			} catch (e) {
				return err(`geocoding failed: ${e instanceof Error ? e.message : String(e)}`);
			}
			if (!geo) return err(`location not found: ${location}`);

			const params = new URLSearchParams({
				latitude: String(geo.latitude),
				longitude: String(geo.longitude),
				timezone: 'auto',
				forecast_days: String(forecastDays),
				current:
					'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m',
				daily:
					'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max'
			});

			let data: ForecastResponse;
			try {
				data = (await fetchJson(`${FORECAST_URL}?${params}`)) as ForecastResponse;
			} catch (e) {
				return err(`forecast fetch failed: ${e instanceof Error ? e.message : String(e)}`);
			}

			const c = data.current ?? {};
			const d = data.daily ?? {};
			const times = d.time ?? [];
			const daily = times.map((date, i) => ({
				date,
				code: d.weather_code?.[i] ?? null,
				tmin: d.temperature_2m_min?.[i] ?? null,
				tmax: d.temperature_2m_max?.[i] ?? null,
				precipSum: d.precipitation_sum?.[i] ?? null,
				precipProb: d.precipitation_probability_max?.[i] ?? null,
				windMax: d.wind_speed_10m_max?.[i] ?? null
			}));

			const payload = {
				location: {
					name: geo.name,
					country: geo.country ?? null,
					admin1: geo.admin1 ?? null,
					timezone: data.timezone ?? null
				},
				current: {
					temp: c.temperature_2m ?? null,
					feels: c.apparent_temperature ?? null,
					humidity: c.relative_humidity_2m ?? null,
					precip: c.precipitation ?? null,
					wind: c.wind_speed_10m ?? null,
					windDir: c.wind_direction_10m ?? null,
					code: c.weather_code ?? null
				},
				units: { temp: '°C', wind: 'km/h', precip: 'mm' },
				daily
			};

			return text(JSON.stringify(payload));
		}
	);

	return server;
}
