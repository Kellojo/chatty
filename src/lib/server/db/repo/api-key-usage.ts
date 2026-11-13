import type { ApiKeyUsageStats } from '$lib/types.js';
import type { Db } from '../index.js';

const DAY_MS = 24 * 60 * 60_000;

/** UTC calendar day (YYYY-MM-DD) of a timestamp. */
function utcDay(timestamp: number): string {
	return new Date(timestamp).toISOString().slice(0, 10);
}

/**
 * A user's API key usage over the last `days` UTC days (today included): per key, and
 * per day split by key. A key's requests are the model requests made with it (proxy,
 * transcription, decisions) plus those of the agent runs it started over HTTP.
 */
export function getApiKeyUsageStats(
	db: Db,
	userId: string,
	days: number,
	now = Date.now()
): ApiKeyUsageStats {
	const firstDay = utcDay(now - (days - 1) * DAY_MS);
	const since = Date.parse(`${firstDay}T00:00:00Z`);
	// Requests of a key's agent runs carry the run, not the key: take the key from the run.
	const keyed = `WITH keyed AS (
		SELECT COALESCE(pr.api_key_id, ar.api_key_id) AS key_id, pr.*
		FROM proxy_requests pr LEFT JOIN agent_runs ar ON ar.id = pr.run_id
		WHERE pr.user_id = ? AND pr.started_at >= ?
	)`;
	const keys = db
		.prepare(
			`${keyed}
			 SELECT key_id AS keyId, COUNT(*) AS requests,
			        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
			        COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0) AS tokens,
			        COALESCE(SUM(cost_usd), 0) AS costUsd,
			        COUNT(cost_usd) AS pricedRequests,
			        AVG(latency_ms) AS avgLatencyMs,
			        MAX(started_at) AS lastUsedAt
			 FROM keyed WHERE key_id IS NOT NULL
			 GROUP BY key_id ORDER BY requests DESC, key_id`
		)
		.all(userId, since) as {
		keyId: string;
		requests: number;
		failed: number;
		tokens: number;
		costUsd: number;
		pricedRequests: number;
		avgLatencyMs: number | null;
		lastUsedAt: number;
	}[];
	const runs = new Map(
		(
			db
				.prepare(
					`SELECT api_key_id AS keyId, COUNT(*) AS runs FROM agent_runs
					 WHERE user_id = ? AND api_key_id IS NOT NULL AND started_at >= ?
					 GROUP BY api_key_id`
				)
				.all(userId, since) as { keyId: string; runs: number }[]
		).map((r) => [r.keyId, r.runs])
	);
	const cells = db
		.prepare(
			`${keyed}
			 SELECT date(started_at / 1000, 'unixepoch') AS day, key_id AS keyId,
			        COUNT(*) AS requests,
			        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
			        COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0) AS tokens,
			        COALESCE(SUM(cost_usd), 0) AS cost
			 FROM keyed WHERE key_id IS NOT NULL GROUP BY day, key_id`
		)
		.all(userId, since) as {
		day: string;
		keyId: string;
		requests: number;
		failed: number;
		tokens: number;
		cost: number;
	}[];

	const daily = Array.from({ length: days }, (_, i) => ({
		day: utcDay(since + i * DAY_MS),
		requests: {} as Record<string, number>,
		failed: {} as Record<string, number>,
		tokens: {} as Record<string, number>,
		cost: {} as Record<string, number>
	}));
	const byDay = new Map(daily.map((d) => [d.day, d]));
	for (const c of cells) {
		const d = byDay.get(c.day);
		if (!d) continue;
		d.requests[c.keyId] = c.requests;
		d.failed[c.keyId] = c.failed;
		d.tokens[c.keyId] = c.tokens;
		d.cost[c.keyId] = c.cost;
	}
	return {
		days,
		keys: keys.map((k) => ({
			...k,
			runs: runs.get(k.keyId) ?? 0,
			avgLatencyMs: k.avgLatencyMs === null ? null : Math.round(k.avgLatencyMs)
		})),
		daily
	};
}
