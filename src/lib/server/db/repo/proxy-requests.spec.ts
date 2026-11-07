import { beforeEach, describe, expect, it } from 'vitest';
import type { ServerEvent } from '$lib/types.js';
import { subscribeAllServerEvents } from '../../events/bus.js';
import { openDatabase, type Db } from '../index.js';
import {
	createProxyRequest,
	failRunningProxyRequests,
	finalizeProxyRequest,
	getProxyRequest,
	listProxyRequests,
	proxyRequestDailyCounts,
	proxyRequestDailyModelCounts,
	proxyRequestTopModels,
	proxyRequestProviderUsage,
	proxyRequestStats,
	toPublic
} from './proxy-requests.js';

let db: Db;

beforeEach(() => {
	db = openDatabase(':memory:');
});

function logRequest(userId: string, requestedModel: string, stream = false) {
	return createProxyRequest(db, {
		userId,
		apiKeyId: 'key-1',
		endpoint: 'chat.completions',
		requestedModel,
		stream
	});
}

describe('proxy-requests repo', () => {
	it('creates a running row and finalizes it with usage and cost', () => {
		const row = logRequest('u1', 'fast');
		expect(row.status).toBe('running');
		expect(row.started_at).toBeGreaterThan(0);

		finalizeProxyRequest(db, row.id, {
			status: 'complete',
			httpStatus: 200,
			latencyMs: 120,
			providerId: 'p1',
			modelId: 'm1',
			inputTokens: 10,
			outputTokens: 20,
			costUsd: 0.0004
		});
		const done = getProxyRequest(db, row.id)!;
		expect(done.status).toBe('complete');
		expect(done.latency_ms).toBe(120);
		expect(done.cost_usd).toBe(0.0004);

		const pub = toPublic(done);
		expect(pub).toMatchObject({
			userId: 'u1',
			apiKeyId: 'key-1',
			requestedModel: 'fast',
			providerId: 'p1',
			modelId: 'm1',
			fallbackIndex: 0,
			stream: false,
			compression: null,
			source: 'proxy',
			conversationId: null,
			runId: null,
			messageId: null,
			stepIndex: 0,
			purpose: 'completion'
		});
	});

	it('creates chat/agent rows with source and linkage fields', () => {
		const chat = createProxyRequest(db, {
			userId: 'u1',
			source: 'chat',
			conversationId: 'conv-1',
			messageId: 'msg-1',
			stepIndex: 2,
			endpoint: 'streamText',
			requestedModel: 'fast',
			stream: true
		});
		const chatPub = toPublic(getProxyRequest(db, chat.id)!);
		expect(chatPub).toMatchObject({
			source: 'chat',
			conversationId: 'conv-1',
			messageId: 'msg-1',
			stepIndex: 2,
			purpose: 'completion',
			apiKeyId: null
		});

		const agent = createProxyRequest(db, {
			userId: 'u1',
			source: 'agent',
			conversationId: 'conv-2',
			runId: 'run-1',
			endpoint: 'streamText',
			requestedModel: 'smart',
			stream: true
		});
		expect(toPublic(getProxyRequest(db, agent.id)!).runId).toBe('run-1');

		const title = createProxyRequest(db, {
			userId: 'u1',
			source: 'chat',
			conversationId: 'conv-1',
			purpose: 'title',
			endpoint: 'generateText',
			requestedModel: 'fast',
			stream: false
		});
		expect(toPublic(getProxyRequest(db, title.id)!).purpose).toBe('title');
	});

	it('filters by search across model, endpoint, provider, and error', () => {
		const a = logRequest('u1', 'fast');
		finalizeProxyRequest(db, a.id, {
			status: 'failed',
			providerId: 'acme',
			modelId: 'gpt-x',
			error: 'upstream timeout'
		});
		logRequest('u1', 'smart', true);

		expect(listProxyRequests(db, { search: 'fast' }).total).toBe(1);
		expect(listProxyRequests(db, { search: 'chat.completions' }).total).toBe(2);
		expect(listProxyRequests(db, { search: 'acme' }).total).toBe(1);
		expect(listProxyRequests(db, { search: 'gpt-x' }).total).toBe(1);
		expect(listProxyRequests(db, { search: 'timeout' }).total).toBe(1);
		expect(listProxyRequests(db, { search: 'nomatch' }).total).toBe(0);
	});

	it('filters by source', () => {
		logRequest('u1', 'fast');
		createProxyRequest(db, {
			userId: 'u1',
			source: 'chat',
			conversationId: 'conv-1',
			endpoint: 'streamText',
			requestedModel: 'fast',
			stream: true
		});
		createProxyRequest(db, {
			userId: 'u1',
			source: 'agent',
			runId: 'run-1',
			endpoint: 'streamText',
			requestedModel: 'fast',
			stream: true
		});

		expect(listProxyRequests(db, {}).total).toBe(3);
		expect(listProxyRequests(db, { source: 'proxy' }).total).toBe(1);
		expect(listProxyRequests(db, { source: 'chat' }).total).toBe(1);
		expect(listProxyRequests(db, { source: 'agent' }).total).toBe(1);
		expect(proxyRequestStats(db, { source: 'chat' }).total).toBe(1);
	});

	it('stores compression metadata as JSON', () => {
		const row = logRequest('u1', 'fast');
		finalizeProxyRequest(db, row.id, {
			status: 'complete',
			compression: {
				caveman: { level: 'full', estSaved: 42 }
			}
		});
		expect(toPublic(getProxyRequest(db, row.id)!).compression).toEqual({
			caveman: { level: 'full', estSaved: 42 }
		});
	});

	it('lists with filters and pagination totals', () => {
		logRequest('u1', 'fast');
		logRequest('u1', 'smart', true);
		logRequest('u2', 'fast');
		const all = listProxyRequests(db, { userId: 'u1' });
		expect(all.total).toBe(2);
		expect(all.rows).toHaveLength(2);

		expect(listProxyRequests(db, { model: 'fast' }).total).toBe(2);
		expect(listProxyRequests(db, { apiKeyId: 'key-1', model: 'smart' }).total).toBe(1);
		expect(listProxyRequests(db, { status: 'running' }).total).toBe(3);
		expect(listProxyRequests(db, { status: 'complete' }).total).toBe(0);
		expect(listProxyRequests(db, { endpoint: 'responses' }).total).toBe(0);

		const page = listProxyRequests(db, {}, 2, 2);
		expect(page.total).toBe(3);
		expect(page.rows).toHaveLength(1);
	});

	it('aggregates stats honoring filters', () => {
		const a = logRequest('u1', 'fast');
		finalizeProxyRequest(db, a.id, {
			status: 'complete',
			latencyMs: 100,
			inputTokens: 10,
			outputTokens: 20,
			costUsd: 0.001,
			compression: { caveman: { level: 'lite', estSaved: 5 } }
		});
		const b = logRequest('u1', 'smart');
		finalizeProxyRequest(db, b.id, {
			status: 'failed',
			latencyMs: 300,
			error: 'boom'
		});
		const c = logRequest('u2', 'fast');
		finalizeProxyRequest(db, c.id, { status: 'complete', latencyMs: 200, outputTokens: 7 });

		const stats = proxyRequestStats(db);
		expect(stats).toEqual({
			total: 3,
			completed: 2,
			failed: 1,
			avgLatencyMs: 200,
			inputTokens: 10,
			outputTokens: 27,
			costUsd: 0.001,
			distinctModels: 2,
			cavemanSaved: 5
		});

		const u1 = proxyRequestStats(db, { userId: 'u1' });
		expect(u1.total).toBe(2);
		expect(u1.outputTokens).toBe(20);

		expect(proxyRequestStats(db, { model: 'nope' }).total).toBe(0);
	});

	it('failRunningProxyRequests marks only running rows', () => {
		const running = logRequest('u1', 'fast');
		const done = logRequest('u1', 'fast');
		finalizeProxyRequest(db, done.id, { status: 'complete' });

		expect(failRunningProxyRequests(db)).toBe(1);
		const row = getProxyRequest(db, running.id)!;
		expect(row.status).toBe('failed');
		expect(row.error).toBe('Interrupted by server restart');
		expect(row.latency_ms).not.toBeNull();
		expect(failRunningProxyRequests(db)).toBe(0);
	});

	it('publishes started and finished server events', () => {
		const received: { userId: string; event: ServerEvent }[] = [];
		const off = subscribeAllServerEvents((userId, event) => received.push({ userId, event }));
		try {
			const row = logRequest('u1', 'fast');
			finalizeProxyRequest(db, row.id, { status: 'complete' });
			expect(received).toEqual([
				{ userId: 'u1', event: { type: 'proxy.request.started', requestId: row.id } },
				{
					userId: 'u1',
					event: { type: 'proxy.request.finished', requestId: row.id, status: 'complete' }
				}
			]);
		} finally {
			off();
		}
	});
});

describe('proxyRequestProviderUsage', () => {
	const DAY = 86_400_000;
	const base = Date.UTC(2026, 0, 10, 12, 0, 0);

	function served(
		userId: string,
		providerId: string | null,
		modelId: string | null,
		startedAt: number,
		usage: { input: number; output: number; cost: number | null }
	) {
		const row = logRequest(userId, 'alias');
		finalizeProxyRequest(db, row.id, {
			status: 'complete',
			httpStatus: 200,
			latencyMs: 10,
			providerId,
			modelId,
			inputTokens: usage.input,
			outputTokens: usage.output,
			costUsd: usage.cost
		});
		db.prepare('UPDATE proxy_requests SET started_at = ? WHERE id = ?').run(startedAt, row.id);
	}

	beforeEach(() => {
		db.prepare(
			`INSERT INTO providers (id, name, type, enabled, created_at)
			 VALUES ('p1', 'OpenRouter', 'openai-compatible', 1, 0)`
		).run();
	});

	it('groups cost, tokens and request counts by day, provider and model', () => {
		served('u1', 'p1', 'gpt-x', base, { input: 10, output: 5, cost: 0.01 });
		served('u1', 'p1', 'gpt-x', base + 1000, { input: 20, output: 5, cost: 0.02 });
		served('u1', 'p1', 'gpt-y', base, { input: 1, output: 1, cost: null });
		served('u1', 'p1', 'gpt-x', base + DAY, { input: 3, output: 3, cost: 0.5 });

		const rows = proxyRequestProviderUsage(db, { userId: 'u1' });
		expect(rows).toEqual([
			{
				day: '2026-01-10',
				providerId: 'p1',
				providerName: 'OpenRouter',
				model: 'gpt-x',
				requests: 2,
				inputTokens: 30,
				outputTokens: 10,
				costUsd: 0.03
			},
			{
				day: '2026-01-10',
				providerId: 'p1',
				providerName: 'OpenRouter',
				model: 'gpt-y',
				requests: 1,
				inputTokens: 1,
				outputTokens: 1,
				costUsd: 0
			},
			{
				day: '2026-01-11',
				providerId: 'p1',
				providerName: 'OpenRouter',
				model: 'gpt-x',
				requests: 1,
				inputTokens: 3,
				outputTokens: 3,
				costUsd: 0.5
			}
		]);
	});

	it('filters by user and time window', () => {
		served('u1', 'p1', 'gpt-x', base, { input: 1, output: 1, cost: 1 });
		served('u1', 'p1', 'gpt-x', base - 40 * DAY, { input: 1, output: 1, cost: 1 });
		served('u2', 'p1', 'gpt-x', base, { input: 1, output: 1, cost: 1 });

		const rows = proxyRequestProviderUsage(db, { userId: 'u1', from: base - 30 * DAY });
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ day: '2026-01-10', requests: 1, costUsd: 1 });
	});

	it('falls back to the requested model and null provider name for unknown providers', () => {
		served('u1', 'gone', null, base, { input: 1, output: 1, cost: 0.1 });
		served('u1', null, null, base, { input: 1, output: 1, cost: 0.2 });

		const rows = proxyRequestProviderUsage(db, { userId: 'u1' });
		expect(rows.map((r) => [r.providerId, r.providerName, r.model])).toEqual([
			[null, null, 'alias'],
			['gone', null, 'alias']
		]);
	});

	it('filters by served provider across list, stats and provider usage', () => {
		db.prepare(
			`INSERT INTO providers (id, name, type, enabled, created_at)
			 VALUES ('p2', 'Anthropic', 'anthropic', 1, 0)`
		).run();
		served('u1', 'p1', 'gpt-x', base, { input: 10, output: 5, cost: 0.01 });
		served('u1', 'p2', 'claude-x', base, { input: 20, output: 5, cost: 0.5 });
		served('u1', null, null, base, { input: 1, output: 1, cost: null });

		const filters = { userId: 'u1', providerId: 'p2' };
		const { rows, total } = listProxyRequests(db, filters);
		expect(total).toBe(1);
		expect(rows[0].provider_id).toBe('p2');
		expect(proxyRequestStats(db, filters)).toMatchObject({ total: 1, costUsd: 0.5 });
		expect(proxyRequestProviderUsage(db, filters)).toEqual([
			expect.objectContaining({ providerId: 'p2', providerName: 'Anthropic', costUsd: 0.5 })
		]);
	});

	it('totals an earlier window via stats from/to (previous-period comparison)', () => {
		served('u1', 'p1', 'gpt-x', base, { input: 1, output: 1, cost: 2 });
		served('u1', 'p1', 'gpt-x', base - 10 * DAY, { input: 1, output: 1, cost: 0.75 });
		served('u1', 'p1', 'gpt-x', base - 40 * DAY, { input: 1, output: 1, cost: 5 });

		const periodStart = base - 7 * DAY;
		const previous = proxyRequestStats(db, {
			userId: 'u1',
			from: periodStart - 30 * DAY,
			to: periodStart - 1
		});
		expect(previous).toMatchObject({ total: 1, costUsd: 0.75 });
	});

	it('shifts day boundaries by the UTC offset', () => {
		served('u1', 'p1', 'gpt-x', Date.UTC(2026, 0, 10, 23, 30), { input: 1, output: 1, cost: 1 });

		expect(proxyRequestProviderUsage(db, { userId: 'u1' })[0].day).toBe('2026-01-10');
		expect(proxyRequestProviderUsage(db, { userId: 'u1' }, 60)[0].day).toBe('2026-01-11');
	});
});

describe('daily chart buckets', () => {
	it('shift day boundaries by the UTC offset', () => {
		const now = Date.now();
		const row = logRequest('u1', 'fast');
		// 23:30 UTC yesterday: still "yesterday" in UTC, already "today" one hour ahead.
		const startOfTodayUtc = Math.floor(now / 86_400_000) * 86_400_000;
		const at = startOfTodayUtc - 30 * 60_000;
		db.prepare('UPDATE proxy_requests SET started_at = ? WHERE id = ?').run(at, row.id);
		const utcDay = new Date(at).toISOString().slice(0, 10);
		const shiftedDay = new Date(startOfTodayUtc).toISOString().slice(0, 10);

		expect(proxyRequestDailyCounts(db, 5, { userId: 'u1' })[0].day).toBe(utcDay);
		expect(proxyRequestDailyCounts(db, 5, { userId: 'u1' }, 60)[0].day).toBe(shiftedDay);
		expect(proxyRequestDailyModelCounts(db, 5, { userId: 'u1' }, 60)[0].day).toBe(shiftedDay);
	});
});

describe('chart queries honour the page filters', () => {
	function at(userId: string, model: string, startedAt: number) {
		const row = logRequest(userId, model);
		db.prepare('UPDATE proxy_requests SET started_at = ? WHERE id = ?').run(startedAt, row.id);
	}

	it('restricts daily counts, daily model counts and top models to user and range', () => {
		const now = Date.now();
		const today = new Date(now).toISOString().slice(0, 10);
		at('u1', 'fast', now - 1000);
		at('u1', 'smart', now - 2000);
		at('u1', 'fast', now - 20 * 86_400_000); // outside the 7-day range
		at('u2', 'fast', now - 1000); // other user

		const filters = { userId: 'u1', from: now - 7 * 86_400_000 };
		expect(proxyRequestDailyCounts(db, 365, filters)).toEqual([
			{ day: today, count: 2, completed: 0, failed: 0 }
		]);
		expect(proxyRequestDailyModelCounts(db, 30, filters)).toEqual(
			expect.arrayContaining([
				{ day: today, model: 'fast', count: 1 },
				{ day: today, model: 'smart', count: 1 }
			])
		);
		expect(proxyRequestDailyModelCounts(db, 30, filters)).toHaveLength(2);
		expect(proxyRequestTopModels(db, 10, filters).map((m) => [m.model, m.count])).toEqual(
			expect.arrayContaining([
				['fast', 1],
				['smart', 1]
			])
		);
		expect(proxyRequestTopModels(db, 10, { userId: 'u1' })[0]).toMatchObject({
			model: 'fast',
			count: 2
		});
	});
});
