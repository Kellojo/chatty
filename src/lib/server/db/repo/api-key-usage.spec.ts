import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../index.js';
import { createAgentRun } from './agent-runs.js';
import { createAgent } from './agents.js';
import { getApiKeyUsageStats } from './api-key-usage.js';

const DAY = 24 * 60 * 60_000;
const NOW = Date.UTC(2026, 10, 13, 12);

let db: Db;
let seq = 0;

function request(
	userId: string,
	at: number,
	opts: {
		keyId?: string | null;
		runId?: string | null;
		status?: string;
		cost?: number | null;
		tokens?: [number, number];
		latency?: number;
	} = {}
) {
	const [input, output] = opts.tokens ?? [10, 5];
	db.prepare(
		`INSERT INTO proxy_requests (id, user_id, api_key_id, run_id, endpoint, requested_model, status,
		   started_at, latency_ms, input_tokens, output_tokens, cost_usd, source)
		 VALUES (?, ?, ?, ?, '/v1/chat/completions', 'm', ?, ?, ?, ?, ?, ?, 'proxy')`
	).run(
		`r${++seq}`,
		userId,
		opts.keyId ?? null,
		opts.runId ?? null,
		opts.status ?? 'complete',
		at,
		opts.latency ?? 100,
		input,
		output,
		opts.cost === undefined ? 0.01 : opts.cost
	);
}

beforeEach(() => {
	db = openDatabase(':memory:');
	for (const id of ['u1', 'u2']) {
		db.prepare(
			`INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role) VALUES (?, ?, ?, 0, 0, 0, 'user')`
		).run(id, `${id}@example.com`, id);
	}
});

describe('getApiKeyUsageStats', () => {
	it('counts requests per key and day, including those of runs a key started', () => {
		request('u1', NOW, { keyId: 'k1', latency: 100 });
		request('u1', NOW - DAY, { keyId: 'k1', status: 'failed', cost: null, latency: 300 });
		request('u1', NOW, { keyId: 'k2', tokens: [100, 50], cost: 0.5 });
		const agentId = createAgent(db, 'u1', {
			name: 'a',
			systemPrompt: 'x',
			triggerType: 'manual'
		}).id;
		const run = createAgentRun(db, { agentId, userId: 'u1', trigger: 'http', apiKeyId: 'k2' });
		request('u1', NOW, { runId: run.id });
		request('u1', NOW); // a chat request: no key
		request('u2', NOW, { keyId: 'k9' }); // another user's key

		const stats = getApiKeyUsageStats(db, 'u1', 7, NOW);
		expect(stats.days).toBe(7);
		expect(stats.keys).toEqual([
			{
				keyId: 'k1',
				requests: 2,
				failed: 1,
				runs: 0,
				tokens: 30,
				costUsd: 0.01,
				pricedRequests: 1,
				avgLatencyMs: 200,
				lastUsedAt: NOW
			},
			{
				keyId: 'k2',
				requests: 2,
				failed: 0,
				runs: 1,
				tokens: 165,
				costUsd: 0.51,
				pricedRequests: 2,
				avgLatencyMs: 100,
				lastUsedAt: NOW
			}
		]);
		expect(stats.daily).toHaveLength(7);
		expect(stats.daily.at(-1)).toEqual({
			day: '2026-11-13',
			requests: { k1: 1, k2: 2 },
			failed: { k1: 0, k2: 0 },
			tokens: { k1: 15, k2: 165 },
			cost: { k1: 0.01, k2: 0.51 }
		});
		expect(stats.daily.at(-2)).toEqual({
			day: '2026-11-12',
			requests: { k1: 1 },
			failed: { k1: 1 },
			tokens: { k1: 15 },
			cost: { k1: 0 }
		});
	});

	it('leaves out requests before the period', () => {
		request('u1', NOW - 10 * DAY, { keyId: 'k1' });
		const stats = getApiKeyUsageStats(db, 'u1', 7, NOW);
		expect(stats.keys).toEqual([]);
		expect(stats.daily.every((d) => Object.keys(d.requests).length === 0)).toBe(true);
		expect(getApiKeyUsageStats(db, 'u1', 30, NOW).keys[0].requests).toBe(1);
	});
});
