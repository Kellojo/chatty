import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { text } from './shared.js';

const MAX_SECONDS = 300;

export function createWaitServer(): McpServer {
	const server = new McpServer({ name: 'ai-chat-wait', version: '0.1.0' });
	server.registerTool(
		'wait',
		{
			description: `Pause execution for a number of seconds, then report the current time. Use this to check back on long-running tasks, poll for changes, or wait before retrying. Maximum ${MAX_SECONDS} seconds per call.`,
			inputSchema: {
				seconds: z
					.number()
					.int()
					.min(1)
					.max(MAX_SECONDS)
					.describe(`Seconds to wait (1-${MAX_SECONDS})`)
			}
		},
		async ({ seconds }) => {
			const startedAt = Date.now();
			await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
			const endedAt = Date.now();
			return text(
				JSON.stringify({
					waitedSeconds: Math.round((endedAt - startedAt) / 1000),
					currentTime: new Date(endedAt).toISOString()
				})
			);
		}
	);
	return server;
}
