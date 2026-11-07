import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readBodyLimited } from '../../net/readBody.js';
import { safeFetch } from '../../net/safeFetch.js';
import { err, text } from './shared.js';

const MAX_BYTES = 1024 * 1024;

function htmlToText(html: string): string {
	return html
		.replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, '')
		.replace(/<\/(p|div|li|h1|h2|h3|h4|h5|h6|tr|section|article)>|<br\s*\/?>/gi, '\n')
		.replace(/<[^>]*>/g, '')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

export function createWebfetchServer(): McpServer {
	const server = new McpServer({ name: 'ai-chat-webfetch', version: '0.1.0' });
	server.registerTool(
		'fetch',
		{
			description:
				'Fetch a URL and return its body. format=html returns raw HTML; text/markdown strip markup from HTML pages.',
			inputSchema: {
				url: z.string(),
				format: z.enum(['markdown', 'text', 'html']).optional()
			}
		},
		async ({ url, format }) => {
			const fmt = format ?? 'markdown';
			let res: Response;
			try {
				res = await safeFetch(url, {
					headers: { 'user-agent': 'ai-chat/0.1 (+https://localhost)' },
					signal: AbortSignal.timeout(15000)
				});
			} catch (e) {
				return err(`fetch failed: ${e instanceof Error ? e.message : String(e)}`);
			}
			if (!res.ok) return err(`fetch failed with status ${res.status}`);
			let limited;
			try {
				limited = await readBodyLimited(res, MAX_BYTES);
			} catch (e) {
				return err(`fetch failed: ${e instanceof Error ? e.message : String(e)}`);
			}
			const body = limited.body.toString('utf-8');
			const suffix = limited.truncated ? '\n… truncated' : '';
			if (fmt === 'html') return text(body + suffix);
			const contentType = res.headers.get('content-type') ?? '';
			if (/text\/html|application\/xhtml/i.test(contentType)) {
				return text(htmlToText(body) + suffix);
			}
			return text(body + suffix);
		}
	);
	return server;
}
