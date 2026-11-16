import type { ModelMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';

process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

const generateTextMock = vi.fn();
vi.mock('ai', async (importOriginal) => {
	const original = await importOriginal<typeof import('ai')>();
	return { ...original, generateText: (...args: unknown[]) => generateTextMock(...args) };
});
vi.mock('../llm/registry.js', async (importOriginal) => {
	const original = await importOriginal<typeof import('../llm/registry.js')>();
	return { ...original, resolveModel: () => ({}) };
});

const {
	compactStepMessages,
	compactionThreshold,
	createStepSummarizer,
	splitSteps,
	SUMMARY_MARKER
} = await import('./stepCompaction.js');
const { getDb } = await import('../db/index.js');
const { createConversation } = await import('../db/repo/conversations.js');
const { createModel } = await import('../db/repo/models.js');
const { createProvider } = await import('../db/repo/providers.js');
const { listProxyRequests, toPublic } = await import('../db/repo/proxy-requests.js');

function step(id: string, output: string): ModelMessage[] {
	return [
		{
			role: 'assistant',
			content: [{ type: 'tool-call', toolCallId: id, toolName: 'fetch', input: { id } }]
		},
		{
			role: 'tool',
			content: [
				{
					type: 'tool-result',
					toolCallId: id,
					toolName: 'fetch',
					output: { type: 'text', value: output }
				}
			]
		}
	];
}

function run(...outputs: string[]): ModelMessage[] {
	return [
		{ role: 'user', content: [{ type: 'text', text: 'Do the task.' }] },
		...outputs.flatMap((o, i) => step(`c${i}`, o))
	];
}

function outputOf(messages: ModelMessage[], index: number): string {
	const content = messages[index].content as Array<{ type: string; output?: { value: string } }>;
	return content[0].output!.value;
}

describe('compactionThreshold', () => {
	it('derives a budget from the context window', () => {
		expect(compactionThreshold(128_000)).toBe(Math.floor((128_000 - 8192) * 0.85));
	});

	it('falls back to CHAT_COMPACT_TOKENS when the window is unknown', () => {
		expect(compactionThreshold(null)).toBe(60_000);
	});
});

describe('splitSteps', () => {
	it('groups each assistant message with its tool results', () => {
		expect(splitSteps(run('a', 'b'))).toEqual({
			prefixEnd: 1,
			steps: [
				[1, 2],
				[3, 4]
			]
		});
	});
});

describe('compactStepMessages', () => {
	it('leaves the prompt alone under the threshold', async () => {
		const messages = run('x'.repeat(5000));
		const result = await compactStepMessages({
			messages,
			promptTokens: 1000,
			thresholdTokens: 10_000
		});
		expect(result.stage).toBe('none');
		expect(result.messages).toBe(messages);
	});

	it('elides older tool outputs first and keeps recent steps verbatim', async () => {
		const big = 'y'.repeat(8000);
		const messages = run(big, big, big, big);
		const summarize = vi.fn();
		const result = await compactStepMessages({
			messages,
			promptTokens: 9_000,
			thresholdTokens: 9_000,
			summarize
		});
		expect(result.stage).toBe('elided');
		expect(summarize).not.toHaveBeenCalled();
		expect(outputOf(result.messages, 2)).toContain('Earlier tool output elided');
		expect(outputOf(result.messages, 6)).toBe(big);
		expect(outputOf(result.messages, 8)).toBe(big);
		// The input is not mutated.
		expect(outputOf(messages, 2)).toBe(big);
	});

	it('truncates a recent tool output that alone exceeds its share', async () => {
		const huge = 'z'.repeat(100_000);
		const result = await compactStepMessages({
			messages: run('small', huge),
			promptTokens: 26_000,
			thresholdTokens: 10_000
		});
		expect(result.truncated).toBe(1);
		const text = outputOf(result.messages, 4);
		expect(text.length).toBeLessThan(11_000);
		expect(text).toContain('chars truncated');
	});

	it('folds older steps into a summary when eliding is not enough', async () => {
		const messages = run('a', 'b', 'c', 'd');
		const summarize = vi.fn(async () => 'Fetched a and b.');
		const result = await compactStepMessages({
			messages,
			promptTokens: 20_000,
			thresholdTokens: 10_000,
			summarize
		});
		expect(result.stage).toBe('summarized');
		expect(result.foldedSteps).toBe(2);
		expect(summarize).toHaveBeenCalledWith(
			expect.objectContaining({
				previous: null,
				transcript: expect.stringContaining('[tool call fetch]')
			})
		);
		// user prompt + the two kept steps
		expect(result.messages).toHaveLength(5);
		const user = result.messages[0].content as Array<{ type: string; text: string }>;
		expect(user[0].text).toBe('Do the task.');
		expect(user[1].text.startsWith(SUMMARY_MARKER)).toBe(true);
		expect(result.messages[1].role).toBe('assistant');
	});

	it('extends an existing summary instead of stacking a second one', async () => {
		const first = await compactStepMessages({
			messages: run('a', 'b', 'c', 'd'),
			promptTokens: 20_000,
			thresholdTokens: 10_000,
			summarize: async () => 'First summary.'
		});
		const summarize = vi.fn(async () => 'Second summary.');
		const second = await compactStepMessages({
			messages: [...first.messages, ...step('c9', 'e')],
			promptTokens: 20_000,
			thresholdTokens: 10_000,
			summarize
		});
		expect(summarize).toHaveBeenCalledWith(expect.objectContaining({ previous: 'First summary.' }));
		const user = second.messages[0].content as Array<{ type: string; text: string }>;
		expect(user).toHaveLength(2);
		expect(user[1].text).toContain('Second summary.');
	});

	it('keeps the elided history when summarizing fails', async () => {
		const result = await compactStepMessages({
			messages: run('a'.repeat(2000), 'b', 'c'),
			promptTokens: 20_000,
			thresholdTokens: 10_000,
			summarize: async () => {
				throw new Error('model down');
			}
		});
		expect(result.stage).toBe('elided');
		expect(result.messages).toHaveLength(7);
	});
});

describe('createStepSummarizer', () => {
	it('logs a plain chat summary as chat usage, without a run', async () => {
		const db = getDb();
		db.prepare(
			'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, role) VALUES (?, ?, ?, 0, 0, 0, ?)'
		).run('u1', 'A', 'a@b.c', 'admin');
		createProvider(db, { name: 'Prov', type: 'openai-compatible', baseUrl: 'http://x' });
		const provider = db.prepare('SELECT id FROM providers').get() as { id: string };
		createModel(db, { providerId: provider.id, modelId: 'm1' });
		const conv = createConversation(db, 'u1', {
			title: 't',
			providerId: provider.id,
			modelId: 'm1'
		});
		generateTextMock.mockResolvedValueOnce({ text: ' Summary. ', usage: {} });

		const summarize = createStepSummarizer({
			db,
			userId: 'u1',
			conversationId: conv.id,
			fallback: { providerId: provider.id, modelId: 'm1' }
		});
		await expect(summarize({ transcript: 'steps', previous: null })).resolves.toBe('Summary.');

		const [row] = listProxyRequests(db).rows.map(toPublic);
		expect(row).toMatchObject({
			source: 'chat',
			purpose: 'compaction',
			runId: null,
			status: 'complete'
		});
	});
});
