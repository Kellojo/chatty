import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText, tool, type ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { withAnthropicPromptCache } from './promptCache.js';

const ephemeral = { cacheControl: { type: 'ephemeral' } };

describe('withAnthropicPromptCache', () => {
	const messages: ModelMessage[] = [
		{ role: 'user', content: 'first' },
		{ role: 'assistant', content: 'reply' },
		{
			role: 'user',
			content: 'latest',
			providerOptions: { anthropic: { foo: 'bar' }, other: { x: 1 } }
		}
	];
	const tools = {
		a: tool({ description: 'a', inputSchema: z.object({}) }),
		b: tool({ description: 'b', inputSchema: z.object({}) })
	};

	it('marks the system prompt, the last message and the last tool', () => {
		const out = withAnthropicPromptCache({ system: 'sys', messages, tools });
		expect(out.system).toEqual({
			role: 'system',
			content: 'sys',
			providerOptions: { anthropic: ephemeral }
		});
		expect(out.messages.slice(0, 2)).toEqual(messages.slice(0, 2));
		expect(out.messages[2].providerOptions).toEqual({
			anthropic: { foo: 'bar', ...ephemeral },
			other: { x: 1 }
		});
		expect(out.tools.a.providerOptions).toBeUndefined();
		expect(out.tools.b.providerOptions).toEqual({ anthropic: ephemeral });
		expect(out.tools.b.description).toBe('b');
	});

	it('does not mutate its inputs', () => {
		withAnthropicPromptCache({ system: 'sys', messages, tools });
		expect(messages[2].providerOptions).toEqual({ anthropic: { foo: 'bar' }, other: { x: 1 } });
		expect(tools.b.providerOptions).toBeUndefined();
	});

	it('reaches the Anthropic request as cache_control breakpoints', async () => {
		let body: {
			system: { cache_control?: unknown }[];
			messages: { content: { cache_control?: unknown }[] }[];
			tools: { name: string; cache_control?: unknown }[];
		} | null = null;
		const provider = createAnthropic({
			apiKey: 'test',
			fetch: async (_url, init) => {
				body = JSON.parse(String(init?.body));
				return new Response(
					JSON.stringify({
						id: 'msg_1',
						type: 'message',
						role: 'assistant',
						model: 'claude-test',
						content: [{ type: 'text', text: 'ok' }],
						stop_reason: 'end_turn',
						stop_sequence: null,
						usage: { input_tokens: 1, output_tokens: 1 }
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } }
				);
			}
		});
		await generateText({
			model: provider('claude-test'),
			maxOutputTokens: 10,
			...withAnthropicPromptCache({ system: 'sys', messages, tools })
		});
		const sent = body!;
		const mark = { type: 'ephemeral' };
		expect(sent.system.at(-1)?.cache_control).toEqual(mark);
		expect(sent.messages.at(-1)?.content.at(-1)?.cache_control).toEqual(mark);
		expect(sent.messages[0].content.at(-1)?.cache_control).toBeUndefined();
		expect(sent.tools.find((t) => t.name === 'b')?.cache_control).toEqual(mark);
		expect(sent.tools.find((t) => t.name === 'a')?.cache_control).toBeUndefined();
	});

	it('handles an empty prompt without adding empty blocks', () => {
		const out = withAnthropicPromptCache({ system: '', messages: [], tools: {} });
		expect(out).toEqual({ system: '', messages: [], tools: {} });
	});
});
