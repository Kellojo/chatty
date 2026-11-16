import { streamText, type ModelMessage } from 'ai';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { learnedContextLength, resetLearnedContextLimits } from '../llm/contextLimit.js';
import { withContextOverflowRetry } from './overflowRetry.js';

const target = { providerId: 'p', modelId: 'm' };

const reply = (text: string) => [
	{ type: 'stream-start' as const, warnings: [] },
	{ type: 'text-start' as const, id: 't' },
	{ type: 'text-delta' as const, id: 't', delta: text },
	{ type: 'text-end' as const, id: 't' },
	{
		type: 'finish' as const,
		finishReason: { unified: 'stop' as const, raw: 'stop' },
		usage: {
			inputTokens: { total: 5000, noCache: 5000, cacheRead: undefined, cacheWrite: undefined },
			outputTokens: { total: 10, text: 10, reasoning: undefined }
		}
	}
];

const overflow = new Error(
	'Engine protocol predict stream returned an error: Context size has been exceeded.'
);

function setup(first: 'throw' | 'error-part' | 'other-error') {
	const prompts: unknown[] = [];
	const model = new MockLanguageModelV4({
		doStream: async (opts) => {
			prompts.push(opts.prompt);
			if (prompts.length === 1) {
				if (first === 'throw') throw overflow;
				if (first === 'other-error') throw new Error('boom');
				return {
					stream: simulateReadableStream({
						chunks: [
							{ type: 'stream-start' as const, warnings: [] },
							{ type: 'error' as const, error: overflow }
						]
					})
				};
			}
			return { stream: simulateReadableStream({ chunks: reply('ok') }) };
		}
	});
	const compact = vi.fn(async ({ messages }: { messages: ModelMessage[] }) => [
		...messages.slice(0, 1),
		{ role: 'user' as const, content: [{ type: 'text' as const, text: 'compacted' }] }
	]);
	const wrapped = withContextOverflowRetry(model, {
		target,
		reportedContextLength: async () => 75_000,
		compact
	});
	return { wrapped, prompts, compact };
}

async function run(model: ReturnType<typeof setup>['wrapped']) {
	const result = streamText({ model, prompt: 'x'.repeat(80_000), maxRetries: 0 });
	let error: unknown = null;
	for await (const part of result.fullStream) if (part.type === 'error') error = part.error;
	return { text: error ? '' : await result.text, error };
}

describe('withContextOverflowRetry', () => {
	beforeEach(() => resetLearnedContextLimits());

	it.each(['throw', 'error-part'] as const)(
		'learns the limit and retries compacted when the call is rejected (%s)',
		async (mode) => {
			const { wrapped, prompts, compact } = setup(mode);
			const { text } = await run(wrapped);
			expect(text).toBe('ok');
			expect(compact).toHaveBeenCalledOnce();
			expect(JSON.stringify(prompts[1])).toContain('compacted');
			// The ~20k-token prompt did not fit; the 5010-token retry did.
			const limit = learnedContextLength(target, 75_000);
			expect(limit).toBeLessThan(75_000);
			expect(limit).toBeGreaterThanOrEqual(5010);
		}
	);

	it('leaves other errors alone', async () => {
		const { wrapped, prompts, compact } = setup('other-error');
		const { error } = await run(wrapped);
		expect((error as Error).message).toBe('boom');
		expect(prompts).toHaveLength(1);
		expect(compact).not.toHaveBeenCalled();
		expect(learnedContextLength(target, 75_000)).toBeNull();
	});
});
