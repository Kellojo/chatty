import { describe, expect, it } from 'vitest';
import { dayInZone, parseUsageLimits, parseUsageSummary } from './usage.js';
import { describeFailureCause } from './client.js';

describe('parseUsageLimits', () => {
	const config = {
		providers: [
			{
				instanceId: 'claude-main',
				driver: 'claudeAgent',
				displayName: 'Claude',
				auth: { status: 'authenticated', email: 'me@example.com', label: 'Max 20x' },
				usageLimits: {
					checkedAt: '2026-11-07T10:00:00.000Z',
					windows: [
						{
							id: 'five_hour',
							kind: 'session',
							label: 'Session',
							usedPercent: 42.5,
							resetsAt: '2026-11-07T14:30:00.000Z'
						},
						{ id: 'seven_day', kind: 'weekly', label: 'Weekly', usedPercent: 140 },
						{ id: 'broken', kind: 'weekly', label: 'Broken' },
						{ id: 'odd', kind: 'quarterly', usedPercent: 5 }
					]
				}
			},
			{
				instanceId: 'codex',
				driver: 'codex',
				usageLimits: { unavailable: { reason: 'unsupported' } }
			},
			{ instanceId: 'no-limits', driver: 'opencode' },
			'garbage'
		]
	};

	it('maps windows per provider account and skips malformed entries', () => {
		const rows = parseUsageLimits(config, 0);
		expect(rows.map((r) => r.windowId)).toEqual(['five_hour', 'seven_day', 'odd']);
		expect(rows[0]).toMatchObject({
			accountId: 'claude-main',
			provider: 'claudeAgent',
			accountLabel: 'Claude',
			accountEmail: 'me@example.com',
			accountPlan: 'Max 20x',
			windowKind: 'session',
			usedPercent: 42.5,
			resetsAt: Date.parse('2026-11-07T14:30:00.000Z'),
			checkedAt: Date.parse('2026-11-07T10:00:00.000Z')
		});
	});

	it('clamps percentages and normalizes unknown kinds and labels', () => {
		const rows = parseUsageLimits(config, 0);
		expect(rows[1].usedPercent).toBe(100);
		expect(rows[1].resetsAt).toBeNull();
		expect(rows[2]).toMatchObject({ windowKind: 'other', windowLabel: 'odd' });
	});

	it('returns nothing for unexpected payloads', () => {
		expect(parseUsageLimits(null)).toEqual([]);
		expect(parseUsageLimits({ providers: 'nope' })).toEqual([]);
	});
});

describe('parseUsageSummary', () => {
	it('extracts day buckets and pricing completeness', () => {
		const parsed = parseUsageSummary({
			contractVersion: 6,
			sinceDay: '2026-10-09',
			untilDay: '2026-11-07',
			buckets: [
				{
					day: '2026-11-06',
					provider: 'claude',
					model: 'claude-opus-5-5',
					totals: {
						uncachedInputTokens: 100,
						cachedInputTokens: 1000,
						cacheCreationTokens: 50,
						outputTokens: 200,
						reasoningTokens: 20
					},
					costUsd: 1.25,
					costSource: 'modelPriced',
					unpricedRecords: 0,
					sessions: 3
				},
				{
					day: '2026-11-07',
					provider: 'codex',
					model: 'gpt-x',
					totals: { outputTokens: -5 },
					costUsd: Number.NaN,
					costSource: 'modelPriced',
					unpricedRecords: 2,
					sessions: 1
				},
				{ day: 'yesterday', provider: 'claude', model: 'm' }
			]
		});
		expect(parsed.sinceDay).toBe('2026-10-09');
		expect(parsed.untilDay).toBe('2026-11-07');
		expect(parsed.rows).toHaveLength(2);
		expect(parsed.rows[0]).toMatchObject({
			inputTokens: 100,
			cachedInputTokens: 1000,
			cacheCreationTokens: 50,
			outputTokens: 200,
			reasoningTokens: 20,
			costUsd: 1.25,
			priced: true,
			sessions: 3
		});
		expect(parsed.rows[1]).toMatchObject({ outputTokens: 0, costUsd: 0, priced: false });
	});

	it('tolerates a missing summary', () => {
		expect(parseUsageSummary(undefined)).toEqual({ sinceDay: null, untilDay: null, rows: [] });
	});
});

describe('dayInZone', () => {
	it('formats the calendar day in the given time zone', () => {
		const ms = Date.parse('2026-11-07T23:30:00.000Z');
		expect(dayInZone(ms, 'UTC')).toBe('2026-11-07');
		expect(dayInZone(ms, 'Europe/Berlin')).toBe('2026-11-08');
	});
});

describe('describeFailureCause', () => {
	it('reports missing scopes as unauthorized', () => {
		const result = describeFailureCause([
			{
				_tag: 'Fail',
				error: {
					_tag: 'EnvironmentAuthorizationError',
					requiredScope: 'orchestration:read',
					requiredPermission: 'diagnostics:read'
				}
			}
		]);
		expect(result).toEqual({
			message: 'Token is missing the "diagnostics:read" scope',
			unauthorized: true
		});
	});

	it('describes typed failures and defects', () => {
		expect(
			describeFailureCause([
				{ _tag: 'Fail', error: { _tag: 'UsageReadError', detail: 'scan failed' } }
			]).message
		).toBe('scan failed');
		expect(describeFailureCause([{ _tag: 'Die', defect: 'boom' }]).message).toBe(
			'Server error: boom'
		);
		expect(describeFailureCause(null).message).toBe('Request failed');
	});
});
