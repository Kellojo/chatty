import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';
process.env.CHAT_COMPACT_TOKENS = '1000';
process.env.CHAT_COMPACT_KEEP_MESSAGES = '4';

const generateTextMock = vi.fn();
vi.mock('ai', async (importOriginal) => {
	const original = await importOriginal<typeof import('ai')>();
	return { ...original, generateText: (...args: unknown[]) => generateTextMock(...args) };
});

const resolveModelMock = vi.fn(() => ({}));
vi.mock('../llm/registry.js', async (importOriginal) => {
	const original = await importOriginal<typeof import('../llm/registry.js')>();
	return { ...original, resolveModel: () => resolveModelMock() };
});

const { getDb, closeDb } = await import('../db/index.js');
const { createConversation, getConversation } = await import('../db/repo/conversations.js');
const { createMessage } = await import('../db/repo/messages.js');
const { createModel } = await import('../db/repo/models.js');
const { createProvider } = await import('../db/repo/providers.js');
const { latestSummary } = await import('../db/repo/conversation-summaries.js');
const compact = await import('./compact.js');

function textParts(text: string): unknown[] {
	return [{ type: 'text', text }];
}

function seedConversation(
	messageCount: number,
	textLength = 100
): {
	convId: string;
	providerId: string;
	modelId: string;
} {
	const db = getDb();
	db.prepare(
		'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, role) VALUES (?, ?, ?, 0, 0, 0, ?)'
	).run('u1', 'A', 'a@b.c', 'admin');
	createProvider(db, { name: 'Prov', type: 'openai-compatible', baseUrl: 'http://x' });
	const provider = db.prepare('SELECT id FROM providers').get() as { id: string };
	createModel(db, { providerId: provider.id, modelId: 'm1' });
	const conv = createConversation(db, 'u1', {
		title: 't',
		mode: 'chat',
		providerId: provider.id,
		modelId: 'm1'
	});
	for (let i = 0; i < messageCount; i++) {
		createMessage(db, {
			conversationId: conv.id,
			role: i % 2 === 0 ? 'user' : 'assistant',
			parts: textParts('x'.repeat(textLength))
		});
	}
	return { convId: conv.id, providerId: provider.id, modelId: 'm1' };
}

describe('compactThreshold', () => {
	beforeEach(() => {
		closeDb();
	});

	it('returns null when compaction is disabled', async () => {
		vi.resetModules();
		process.env.CHAT_COMPACT_TOKENS = '0';
		const fresh = await import('./compact.js');
		const conv = { max_tokens: null } as import('../db/repo/conversations.js').ConversationRow;
		expect(fresh.compactThreshold(conv, undefined, 10)).toBeNull();
		process.env.CHAT_COMPACT_TOKENS = '1000';
		vi.resetModules();
	});

	it('uses model context length when available', () => {
		const conv = { max_tokens: null } as import('../db/repo/conversations.js').ConversationRow;
		const model = { context_length: 100000 } as import('../db/repo/models.js').ModelRow;
		// (100000 - 4096) * 0.85 = 81518
		expect(compact.compactThreshold(conv, model, 10)).toBe(81518);
	});

	it('respects max_tokens reserve', () => {
		const conv = { max_tokens: 10000 } as import('../db/repo/conversations.js').ConversationRow;
		const model = { context_length: 100000 } as import('../db/repo/models.js').ModelRow;
		// (100000 - 10000) * 0.85 = 76500
		expect(compact.compactThreshold(conv, model, 10)).toBe(76500);
	});

	it('falls back to the env constant without context length', () => {
		const conv = { max_tokens: null } as import('../db/repo/conversations.js').ConversationRow;
		expect(compact.compactThreshold(conv, undefined, 10)).toBe(1000);
		expect(
			compact.compactThreshold(
				conv,
				{ context_length: null } as import('../db/repo/models.js').ModelRow,
				10
			)
		).toBe(1000);
	});

	it('clamps to a floor so tiny windows still work', () => {
		const conv = { max_tokens: null } as import('../db/repo/conversations.js').ConversationRow;
		const model = { context_length: 4000 } as import('../db/repo/models.js').ModelRow;
		expect(compact.compactThreshold(conv, model, 10)).toBe(4000);
	});
});

describe('maybeCompactConversation', () => {
	beforeEach(() => {
		closeDb();
		generateTextMock.mockReset();
		generateTextMock.mockResolvedValue({
			text: 'Condensed summary of the discussion.',
			usage: { inputTokens: 500, outputTokens: 50 }
		});
	});

	it('does nothing below the threshold', async () => {
		const { convId, providerId, modelId } = seedConversation(3, 50);
		const conv = getConversation(getDb(), 'u1', convId)!;
		await compact.maybeCompactConversation(conv, 'u1', { providerId, modelId });
		expect(generateTextMock).not.toHaveBeenCalled();
		expect(latestSummary(getDb(), convId)).toBeUndefined();
	});

	it('compacts old messages when history exceeds the threshold', async () => {
		// 20 messages * 100 chars = 2000 chars = ~500 tokens raw, but text
		// parts are 100 chars each so ~25 tokens/message -> ~500 total.
		// Threshold 1000 -> not enough. Use longer texts.
		const { convId, providerId, modelId } = seedConversation(30, 200);
		// 30 * 200 chars = 6000 chars = 1500 tokens > 1000 threshold.
		const conv = getConversation(getDb(), 'u1', convId)!;
		await compact.maybeCompactConversation(conv, 'u1', { providerId, modelId });
		expect(generateTextMock).toHaveBeenCalledOnce();
		const summary = latestSummary(getDb(), convId)!;
		expect(summary.summary_text).toBe('Condensed summary of the discussion.');
		// Keep window is 4 -> folded 26 messages.
		const messages = getDb()
			.prepare('SELECT rowid FROM messages WHERE conversation_id = ? ORDER BY rowid')
			.all(convId) as { rowid: number }[];
		expect(summary.through_rowid).toBe(messages[25].rowid);
	});

	it('folds new messages into an existing summary incrementally', async () => {
		const { convId, providerId, modelId } = seedConversation(30, 200);
		const db = getDb();
		const conv = getConversation(db, 'u1', convId)!;
		await compact.maybeCompactConversation(conv, 'u1', { providerId, modelId });
		const first = latestSummary(db, convId)!;
		generateTextMock.mockResolvedValue({
			text: 'Extended summary.',
			usage: { inputTokens: 800, outputTokens: 60 }
		});
		// Add 10 more long messages -> foldable = unsummarized (10) - keep (4) = 6,
		// 6 * 200 chars = 1200 chars = 300 tokens; existing summary token_estimate
		// is ~40 -> 340 < 1000 threshold. Add many more.
		for (let i = 0; i < 30; i++) {
			createMessage(db, {
				conversationId: convId,
				role: 'user',
				parts: textParts('y'.repeat(200))
			});
		}
		await compact.maybeCompactConversation(conv, 'u1', { providerId, modelId });
		expect(generateTextMock).toHaveBeenCalledTimes(2);
		const second = latestSummary(db, convId)!;
		expect(second.summary_text).toBe('Extended summary.');
		expect(second.through_rowid).toBeGreaterThan(first.through_rowid);
		// The second prompt should include the previous summary.
		const prompt = generateTextMock.mock.calls[1][0].prompt as string;
		expect(prompt).toContain('Previous summary');
		expect(prompt).toContain('Condensed summary of the discussion.');
	});

	it('leaves no summary and logs a failed request when the model errors', async () => {
		const { convId, providerId, modelId } = seedConversation(30, 200);
		generateTextMock.mockRejectedValue(new Error('model exploded'));
		const conv = getConversation(getDb(), 'u1', convId)!;
		await compact.maybeCompactConversation(conv, 'u1', { providerId, modelId });
		expect(latestSummary(getDb(), convId)).toBeUndefined();
		const failed = getDb()
			.prepare("SELECT status FROM proxy_requests WHERE purpose = 'compaction'")
			.get() as { status: string };
		expect(failed.status).toBe('failed');
	});

	it('records the compaction request with the compaction purpose', async () => {
		const { convId, providerId, modelId } = seedConversation(30, 200);
		const conv = getConversation(getDb(), 'u1', convId)!;
		await compact.maybeCompactConversation(conv, 'u1', { providerId, modelId });
		const row = getDb()
			.prepare("SELECT purpose, status FROM proxy_requests WHERE purpose = 'compaction'")
			.get() as { purpose: string; status: string };
		expect(row.purpose).toBe('compaction');
		expect(row.status).toBe('complete');
	});
});
