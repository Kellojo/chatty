import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/**
 * End-to-end check of in-turn step compaction: a real `streamText` tool loop
 * (mock model, one local tool returning large pages) driven through a plain
 * chat and an agent run. The model must see a compacted prompt, while the
 * persisted reply keeps every tool output in full.
 */

process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';
process.env.WORKSPACES_VOLUME = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-compaction-'));
// No context length is known for the mock model, so this is the threshold.
process.env.CHAT_COMPACT_TOKENS = '2000';

const PAGE_CHARS = 12_000;
const TOOL_ROUNDS = 3;
const SUMMARY = 'SUMMARY-OF-EARLIER-STEPS';

/** The prompt of each model call in the current test. */
const prompts: unknown[] = [];

vi.mock('../llm/registry.js', async () => {
	const { MockLanguageModelV3 } = await import('ai/test');
	const { simulateReadableStream } = await import('ai');
	// No input token count: the compactor then estimates from the messages.
	const usage = {
		inputTokens: {
			total: undefined,
			noCache: undefined,
			cacheRead: undefined,
			cacheWrite: undefined
		},
		outputTokens: { total: 1, text: 1, reasoning: undefined }
	};
	const model = new MockLanguageModelV3({
		doStream: async (options) => {
			const call = prompts.length;
			prompts.push(options.prompt);
			const chunks =
				call < TOOL_ROUNDS
					? [
							{
								type: 'tool-call',
								toolCallId: `call-${call}`,
								toolName: 'big_fetch',
								input: JSON.stringify({ page: call })
							},
							{ type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage }
						]
					: [
							{ type: 'text-start', id: 't1' },
							{ type: 'text-delta', id: 't1', delta: 'Done reading.' },
							{ type: 'text-end', id: 't1' },
							{ type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage }
						];
			return { stream: simulateReadableStream({ chunks: chunks as never[] }) };
		}
	});
	return {
		resolveModel: () => model,
		roleModel: () => undefined,
		ModelUnavailableError: class ModelUnavailableError extends Error {}
	};
});

// Summaries (step and conversation compaction) come from generateText.
const generateTextMock = vi.fn(async () => ({ text: SUMMARY, usage: {} }));
vi.mock('ai', async (importOriginal) => {
	const original = await importOriginal<typeof import('ai')>();
	return { ...original, generateText: () => generateTextMock() };
});

vi.mock('../tools/registry.js', async () => {
	const { tool } = await import('ai');
	const { z } = await import('zod');
	return {
		buildTools: async () => ({
			tools: {
				big_fetch: tool({
					description: 'Fetches a large page.',
					inputSchema: z.object({ page: z.number() }),
					execute: async ({ page }) => `PAGE-${page} ${'x'.repeat(PAGE_CHARS)}`
				})
			},
			toolToServer: { big_fetch: 'test' },
			deferred: new Set(),
			close: async () => undefined
		})
	};
});

const { getDb, closeDb } = await import('../db/index.js');
const { handleChatRequest } = await import('./service.js');
const { startAgentRun } = await import('../agents/runner.js');
const { createAgent } = await import('../db/repo/agents.js');
const { createConversation } = await import('../db/repo/conversations.js');
const { listMessages } = await import('../db/repo/messages.js');
const { createProvider } = await import('../db/repo/providers.js');
const { createModel } = await import('../db/repo/models.js');
const { SUMMARY_MARKER } = await import('../agents/stepCompaction.js');

type Db = ReturnType<typeof getDb>;

function seed(db: Db) {
	db.prepare(
		"INSERT INTO \"user\" (id, name, email, emailVerified, createdAt, updatedAt, role) VALUES ('u1', 'A', 'a@b.c', 0, 0, 0, 'user')"
	).run();
	createProvider(db, { name: 'P', type: 'openai-compatible' });
	db.prepare("UPDATE providers SET id = 'p1'").run();
	createModel(db, { providerId: 'p1', modelId: 'm1' });
}

const fullPage = 'x'.repeat(PAGE_CHARS);

/** Asserts the model's prompts were compacted and the stored reply was not. */
function expectCompactedTurn(db: Db, conversationId: string) {
	expect(prompts).toHaveLength(TOOL_ROUNDS + 1);
	// One page alone exceeds the budget, so it is cut down right away...
	const second = JSON.stringify(prompts[1]);
	expect(second).toContain('PAGE-0');
	expect(second).toContain('chars truncated to save context');
	expect(second).not.toContain(fullPage);
	// ...and by the final step older steps are folded into the summary.
	const last = JSON.stringify(prompts[TOOL_ROUNDS]);
	expect(last).not.toContain(fullPage);
	expect(last).toContain(SUMMARY_MARKER.slice(1, -1));
	expect(last).toContain(SUMMARY);

	// The visible transcript keeps every step with its full output.
	const assistant = listMessages(db, conversationId).find((m) => m.role === 'assistant')!;
	expect(assistant.status).toBe('complete');
	const parts = JSON.parse(assistant.parts) as Array<{
		type: string;
		output?: unknown;
		text?: string;
	}>;
	const outputs = parts.filter((p) => p.type === 'tool-big_fetch').map((p) => p.output);
	expect(outputs).toHaveLength(TOOL_ROUNDS);
	for (const [i, output] of outputs.entries()) {
		expect(output).toBe(`PAGE-${i} ${fullPage}`);
	}
	expect(parts).toContainEqual(expect.objectContaining({ type: 'text', text: 'Done reading.' }));
	return assistant.id;
}

/** The step-summary requests logged for a reply. */
function stepSummaryRows(db: Db, messageId: string) {
	return db
		.prepare(
			"SELECT source, run_id, status FROM proxy_requests WHERE purpose = 'compaction' AND message_id = ?"
		)
		.all(messageId) as { source: string; run_id: string | null; status: string }[];
}

describe('in-turn step compaction', () => {
	it('compacts a plain chat tool loop without touching the stored reply', async () => {
		prompts.length = 0;
		generateTextMock.mockClear();
		const db = getDb();
		try {
			seed(db);
			const conversation = createConversation(db, 'u1', { providerId: 'p1', modelId: 'm1' });
			db.prepare("UPDATE conversations SET title = 't' WHERE id = ?").run(conversation.id);

			const res = await handleChatRequest('u1', {
				conversationId: conversation.id,
				message: { id: 'msg-1', role: 'user', parts: [{ type: 'text', text: 'read 3 pages' }] }
			});
			expect(res.status).toBe(200);
			await res.text();
			await new Promise((r) => setTimeout(r, 100));

			const assistantId = expectCompactedTurn(db, conversation.id);
			const rows = stepSummaryRows(db, assistantId);
			expect(rows.length).toBeGreaterThan(0);
			expect(rows.every((r) => r.source === 'chat' && r.run_id === null)).toBe(true);
			expect(rows.every((r) => r.status === 'complete')).toBe(true);
		} finally {
			closeDb();
		}
	});

	it('compacts an agent run tool loop and bills the summary to the run', async () => {
		prompts.length = 0;
		generateTextMock.mockClear();
		const db = getDb();
		try {
			seed(db);
			const agent = createAgent(db, 'u1', {
				name: 'reader',
				systemPrompt: 'You read pages.',
				providerId: 'p1',
				modelId: 'm1',
				triggerType: 'manual',
				canAsk: 'never'
			});

			const { run, done } = await startAgentRun({
				agentId: agent.id,
				trigger: 'manual',
				userId: 'u1'
			});
			const finished = await done;
			expect(finished.status).toBe('success');

			const assistantId = expectCompactedTurn(db, finished.conversation_id!);
			const rows = stepSummaryRows(db, assistantId);
			expect(rows.length).toBeGreaterThan(0);
			expect(rows.every((r) => r.source === 'agent' && r.run_id === run.id)).toBe(true);
		} finally {
			closeDb();
		}
	});
});
