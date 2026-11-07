// Regression test: load + SSR-render every Usage page against realistic data (free/local
// pay-as-you-go only, one coding environment with plan limits and unpriced providers).
import { beforeEach, describe, expect, it } from 'vitest';
import { render } from 'svelte/server';

process.env.DATABASE_PATH = ':memory:';

const { closeDb, getDb } = await import('$lib/server/db/index.js');
const { createProxyRequest, finalizeProxyRequest } =
	await import('$lib/server/db/repo/proxy-requests.js');
const { load: loadOverview } = await import('./+page.server.js');
const { load: loadSubscriptions } = await import('./subscriptions/+page.server.js');
const { load: loadRequests } = await import('./requests/+page.server.js');
const { default: OverviewPage } = await import('./+page.svelte');
const { default: SubscriptionsPage } = await import('./subscriptions/+page.svelte');
const { default: RequestsPage } = await import('./requests/+page.svelte');

const admin = { id: 'admin', role: 'admin' };
const DAY = 86_400_000;

function seed() {
	const db = getDb();
	const now = Date.now();
	db.prepare(
		`INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role)
		 VALUES ('admin', 'admin@x.y', 'Admin', 0, 0, 0, 'admin')`
	).run();
	db.prepare(
		`INSERT INTO providers (id, name, type, enabled, created_at)
		 VALUES ('lm', 'LM Studio', 'openai-compatible', 1, 0)`
	).run();
	for (let i = 0; i < 10; i++) {
		const row = createProxyRequest(db, {
			userId: 'admin',
			endpoint: 'chat.completions',
			requestedModel: i % 3 === 0 ? 'qwen-local' : 'llama-local',
			stream: false
		});
		finalizeProxyRequest(db, row.id, {
			status: i === 9 ? 'failed' : 'complete',
			providerId: i === 9 ? null : 'lm',
			modelId: i === 9 ? null : 'qwen',
			inputTokens: i === 9 ? null : 1000,
			outputTokens: i === 9 ? null : 200,
			costUsd: i % 2 === 0 ? 0 : null
		});
		db.prepare('UPDATE proxy_requests SET started_at = ? WHERE id = ?').run(now - i * DAY, row.id);
	}

	db.prepare(
		`INSERT INTO coding_environments (id, user_id, name, base_url, token_enc, enabled, status,
		   environment_label, server_version, last_synced_at, last_checked_at, created_at, updated_at)
		 VALUES ('env1', 'admin', 'Daniels-PC', 'http://pc:3773', 'x', 1, 'online', 'Daniels-PC',
		   '1.2.3', ?, ?, 0, 0)`
	).run(now - 60_000, now - 60_000);
	db.prepare(
		`INSERT INTO coding_usage_limits (environment_id, account_id, provider, account_label,
		   account_email, account_plan, window_id, window_kind, window_label, used_percent,
		   resets_at, checked_at)
		 VALUES ('env1', 'acc1', 'claude', 'Claude', 'me@x.y', 'Max', 'session', 'session',
		   'Session', 52, ?, ?),
		        ('env1', 'acc1', 'claude', 'Claude', 'me@x.y', 'Max', 'weekly', 'weekly',
		   'Weekly', 31, ?, ?)`
	).run(now + 3_600_000, now, now + 3 * DAY, now);
	const insertDaily = db.prepare(
		`INSERT INTO coding_usage_daily (environment_id, day, provider, model, input_tokens,
		   cached_input_tokens, cache_creation_tokens, output_tokens, reasoning_tokens, cost_usd,
		   priced, sessions)
		 VALUES ('env1', ?, ?, ?, 1000, 500, 0, 300, 0, ?, ?, 2)`
	);
	for (let i = 0; i < 5; i++) {
		const day = new Date(now - i * DAY).toISOString().slice(0, 10);
		insertDaily.run(day, 'claude', 'claude-opus', 12.5, 1);
		insertDaily.run(day, 'opencode', 'big-pickle', 0, 0);
		insertDaily.run(day, 'pi', 'pi-model', 0, 0);
	}
}

function event(path: string) {
	return {
		locals: { user: admin, session: null } as unknown as App.Locals,
		url: new URL(`http://localhost${path}`),
		params: {}
	} as never;
}

/** Page data as SvelteKit would merge it: parent layout data + this page's load. */
async function pageData(load: (e: never) => unknown, path: string) {
	return {
		user: { name: 'Admin', email: 'admin@x.y', image: null, role: 'admin' },
		...((await load(event(path))) as object)
	};
}

beforeEach(() => {
	closeDb();
	seed();
});

describe('usage pages render with real-shaped data', () => {
	it('renders the Overview (free/local pay-as-you-go, unpriced subscriptions)', async () => {
		const data = await pageData(loadOverview, '/usage');
		const { body } = render(OverviewPage, { props: { data } as never });
		expect(body).toContain('Requests per day');
		expect(body).toContain('Plan limits');
		expect(body).toContain('Not priced');
	});

	it('renders the Subscriptions tab', async () => {
		const data = await pageData(loadSubscriptions, '/usage/subscriptions?period=7d');
		const { body } = render(SubscriptionsPage, { props: { data } as never });
		expect(body).toContain('Daniels-PC');
		expect(body).toContain('Not priced');
	});

	it('renders the Requests tab', async () => {
		const data = await pageData(loadRequests, '/usage/requests');
		const { body } = render(RequestsPage, { props: { data } as never });
		expect(body).toContain('Request log');
	});

	it('supports every shared time range on the Overview and Subscriptions', async () => {
		const labels: Record<string, string> = {
			'?range=24h': 'last 24 hours',
			'?period=7d': 'last 7 days',
			'?range=all': 'all time',
			'?range=custom&from=2020-01-01': 'today'
		};
		for (const [query, label] of Object.entries(labels)) {
			const overview = (await pageData(loadOverview, `/usage${query}`)) as unknown as {
				rangeLabel: string;
				payg: { totalRequests: number };
				subscriptions: { dailyRows: unknown[]; note: string | null };
			};
			expect(overview.rangeLabel).toContain(label);
			const { body } = render(OverviewPage, { props: { data: overview } as never });
			expect(body).toContain('By provider');
			const subs = (await pageData(
				loadSubscriptions,
				`/usage/subscriptions${query}`
			)) as unknown as {
				subscriptions: { dailyRows: unknown[]; note: string | null };
			};
			render(SubscriptionsPage, { props: { data: subs } as never });
			if (query === '?range=24h') {
				// Daily buckets: 24h shows today's bucket, with a note saying so.
				expect(subs.subscriptions.dailyRows).toHaveLength(1);
				expect(subs.subscriptions.note).toMatch(/today/);
			}
			if (query.startsWith('?range=custom')) {
				// Clamped to the synced history (5 days seeded), with a note.
				expect(subs.subscriptions.dailyRows.length).toBeLessThanOrEqual(6);
				expect(subs.subscriptions.note).toMatch(/only synced from/);
			}
			if (query === '?range=all') expect(overview.payg.totalRequests).toBe(10);
		}
	});
});
