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
