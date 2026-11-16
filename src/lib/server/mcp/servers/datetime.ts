import { DateTime } from 'luxon';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { config } from '../../config.js';
import { err, text } from './shared.js';

const HUMAN_FORMAT = 'yyyy-MM-dd HH:mm:ss ZZZZ';
const MAX_WAIT_SECONDS = 300;

/** City-ish label for an IANA zone: "America/Los_Angeles" -> "Los Angeles". */
export function zoneLabel(zone: string): string {
	const last = zone.split('/').pop() ?? zone;
	return last.replace(/_/g, ' ');
}

type ClockPayload = { at?: string; convert?: boolean; zones: Array<{ label: string; tz: string }> };

function payload(dt: DateTime, clock: ClockPayload): string {
	return JSON.stringify({
		iso: dt.toISO(),
		timezone: dt.zoneName,
		human: dt.toFormat(HUMAN_FORMAT),
		clock
	});
}

/** Sleeps `seconds`, or stops early with an error result when `signal` aborts. */
export async function waitSeconds(seconds: number, signal?: AbortSignal): Promise<CallToolResult> {
	const startedAt = Date.now();
	const aborted = await new Promise<boolean>((resolve) => {
		if (signal?.aborted) return resolve(true);
		const onAbort = () => {
			clearTimeout(timer);
			resolve(true);
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve(false);
		}, seconds * 1000);
		signal?.addEventListener('abort', onAbort, { once: true });
	});
	const endedAt = Date.now();
	if (aborted) return err(`wait cancelled after ${Math.round((endedAt - startedAt) / 1000)}s`);
	return text(
		JSON.stringify({
			waitedSeconds: Math.round((endedAt - startedAt) / 1000),
			currentTime: new Date(endedAt).toISOString()
		})
	);
}

export function createDatetimeServer(): McpServer {
	const server = new McpServer({ name: 'ai-chat-datetime', version: '0.1.0' });

	server.registerTool(
		'now',
		{
			description:
				'Current date and time. For a clock widget, reply with a ```clock block of the result’s `clock` JSON; ' +
				'add {"label","tz"} entries to its `zones` to compare cities.',
			inputSchema: {
				tz: z.string().optional().describe('IANA zone, e.g. "Europe/Berlin"; default: server zone')
			}
		},
		async ({ tz }) => {
			const zone = tz ?? config.TZ;
			const dt = DateTime.now().setZone(zone);
			if (!dt.isValid) return err(`invalid timezone: ${zone}`);
			return text(payload(dt, { zones: [{ label: zoneLabel(dt.zoneName ?? zone), tz: zone }] }));
		}
	);

	server.registerTool(
		'convert',
		{
			description:
				'Convert an ISO timestamp between timezones (IANA names). For a widget, reply with a ' +
				'```clock block of the result’s `clock` JSON.',
			inputSchema: { iso: z.string(), fromTz: z.string(), toTz: z.string() }
		},
		async ({ iso, fromTz, toTz }) => {
			const dt = DateTime.fromISO(iso, { zone: fromTz });
			if (!dt.isValid) return err(dt.invalidExplanation ?? 'invalid input');
			const out = dt.setZone(toTz);
			if (!out.isValid) return err(`invalid timezone: ${toTz}`);
			return text(
				payload(out, {
					at: dt.toUTC().toISO() ?? iso,
					convert: true,
					zones: [
						{ label: zoneLabel(fromTz), tz: fromTz },
						{ label: zoneLabel(toTz), tz: toTz }
					]
				})
			);
		}
	);

	server.registerTool(
		'wait',
		{
			description: `Wait a number of seconds (max ${MAX_WAIT_SECONDS}), then return the current time. For checking back on long-running work, polling, or waiting before a retry.`,
			inputSchema: {
				seconds: z.number().int().min(1).max(MAX_WAIT_SECONDS).describe('Seconds to wait')
			}
		},
		({ seconds }, extra) => waitSeconds(seconds, extra.signal)
	);

	return server;
}
