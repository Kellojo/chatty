import { DateTime } from 'luxon';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config } from '../../config.js';
import { err, text } from './shared.js';

const HUMAN_FORMAT = 'yyyy-MM-dd HH:mm:ss ZZZZ';

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

export function createDatetimeServer(): McpServer {
	const server = new McpServer({ name: 'ai-chat-datetime', version: '0.1.0' });

	server.registerTool(
		'now',
		{
			description:
				'Current date and time. To show a clock widget in chat, reply with a ```clock fenced code ' +
				'block containing the result’s `clock` JSON; add {"label","tz"} entries to `zones` to compare cities.',
			inputSchema: { tz: z.string().optional() }
		},
		async ({ tz }) => {
			const zone = tz ?? config.TZ;
			const dt = DateTime.now().setZone(zone);
			if (!dt.isValid) return err(`invalid timezone: ${zone}`);
			return text(payload(dt, { zones: [{ label: zoneLabel(dt.zoneName ?? zone), tz: zone }] }));
		}
	);

	server.registerTool(
		'get_timezone',
		{
			description: 'Configured default timezone (TZ env setting)',
			inputSchema: {}
		},
		async () => text(JSON.stringify({ timezone: config.TZ }))
	);

	server.registerTool(
		'format',
		{
			description: 'Format an ISO timestamp using a luxon format string',
			inputSchema: { iso: z.string(), fmt: z.string(), tz: z.string().optional() }
		},
		async ({ iso, fmt, tz }) => {
			const dt = DateTime.fromISO(iso, { zone: tz ?? config.TZ });
			if (!dt.isValid) return err(dt.invalidExplanation ?? 'invalid input');
			return text(dt.toFormat(fmt));
		}
	);

	server.registerTool(
		'convert',
		{
			description:
				'Convert an ISO timestamp from one timezone to another. To show the conversion in chat, ' +
				'reply with a ```clock fenced code block containing the result’s `clock` JSON (first zone is the source).',
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

	return server;
}
