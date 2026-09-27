import { describe, expect, it } from 'vitest';
import { jsonSchema } from 'ai';
import { z } from 'zod';
import { estimateMessagesChars, estimateToolChars } from './promptBreakdown.js';

describe('estimateToolChars', () => {
	it('returns 0 for no tools', () => {
		expect(estimateToolChars(undefined)).toBe(0);
		expect(estimateToolChars({})).toBe(0);
	});

	it('counts name, description and plain JSON-schema input', () => {
		const tool = {
			description: 'demo',
			inputSchema: { type: 'object', properties: { q: { type: 'string' } } }
		};
		const chars = estimateToolChars({ my_tool: tool });
		// name (7) + description (4) + schema chars (>0)
		expect(chars).toBeGreaterThan('my_tool'.length + 'demo'.length);
	});

	it('handles AI SDK jsonSchema-wrapped input (MCP path)', () => {
		const tool = {
			description: 'demo',
			inputSchema: jsonSchema({
				type: 'object',
				properties: { name: { type: 'string', description: 'a name' } },
				additionalProperties: false
			})
		};
		expect(estimateToolChars({ demo: tool })).toBeGreaterThan(0);
	});

	it('handles a raw zod inputSchema via toJSONSchema', () => {
		const tool = {
			description: 'demo',
			inputSchema: z.object({ q: z.string().describe('query') })
		};
		expect(estimateToolChars({ demo: tool })).toBeGreaterThan(0);
	});
});

describe('estimateMessagesChars', () => {
	it('is 0 for no messages', () => {
		expect(estimateMessagesChars([])).toBe(0);
	});

	it('counts text part lengths', () => {
		expect(
			estimateMessagesChars([{ id: 'm', role: 'user', parts: [{ type: 'text', text: 'abcd' }] }])
		).toBe(4);
	});

	it('counts tool call input and result output', () => {
		const messages = [
			{
				id: 'm',
				role: 'assistant',
				parts: [
					{
						type: 'tool-weather',
						toolCallId: 't',
						toolName: 'weather',
						input: { city: 'Lisbon' }
					}
				]
			},
			{
				id: 'm2',
				role: 'tool',
				parts: [
					{
						type: 'tool-weather',
						toolCallId: 't',
						toolName: 'weather',
						output: { text: 'sunny' }
					}
				]
			}
		];
		expect(estimateMessagesChars(messages)).toBeGreaterThan('{"city":"Lisbon"}'.length);
	});

	it('uses a fixed budget for file parts, not their raw data', () => {
		const big = 'x'.repeat(100_000);
		const messages = [
			{
				id: 'm',
				role: 'user',
				parts: [
					{
						type: 'file',
						url: 'data:image/png;base64,AAAA',
						mediaType: 'image/png',
						filename: 'a.png',
						data: big
					}
				]
			}
		];
		// a file part contributes a small fixed budget, far below its data size
		expect(estimateMessagesChars(messages)).toBeLessThan(1000);
	});
});
