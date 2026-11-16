import { beforeEach, describe, expect, it } from 'vitest';

process.env.DATABASE_PATH = ':memory:';

const { closeDb, getDb } = await import('../db/index.js');
const { createConversation } = await import('../db/repo/conversations.js');
const { createAgent } = await import('../db/repo/agents.js');
const { createAgentRun } = await import('../db/repo/agent-runs.js');
const policy = await import('./policy.js');
const { seedPrivacyFixture, markConversationPrivate } = await import('./fixtures.js');

let fx: ReturnType<typeof seedPrivacyFixture>;

beforeEach(() => {
	closeDb();
	fx = seedPrivacyFixture(getDb());
});

describe('privacy policy', () => {
	it('trusts only providers an admin allowed', () => {
		const db = getDb();
		expect(policy.providerTrust(db, fx.trusted.providerId)).toBe('trusted');
		expect(policy.providerTrust(db, fx.untrusted.providerId)).toBe('untrusted');
		expect(policy.providerTrust(db, 'missing')).toBe('untrusted');
		expect(policy.hasTrustedProvider(db)).toBe(true);
	});

	it('works out turn trust from every target', () => {
		const db = getDb();
		expect(policy.turnTrust(db, [fx.trusted])).toBe('trusted');
		expect(policy.turnTrust(db, [fx.trusted, fx.untrusted])).toBe('untrusted');
		expect(policy.turnTrust(db, [])).toBe('untrusted');
	});

	it('filters fallbacks only for private contexts', () => {
		const db = getDb();
		const targets = [fx.untrusted, fx.trusted];
		expect(policy.filterTargets(db, targets, policy.NON_PRIVATE)).toEqual(targets);
		expect(policy.filterTargets(db, targets, { tainted: true })).toEqual([fx.trusted]);
	});

	it('re-reads the conversation flag at call time', () => {
		const db = getDb();
		const c = createConversation(db, fx.userId, {});
		const p = { tainted: false, conversationId: c.id };
		expect(() => policy.assertModelAllowed(db, fx.untrusted, p)).not.toThrow();
		markConversationPrivate(db, c.id);
		expect(() => policy.assertModelAllowed(db, fx.untrusted, p)).toThrow(
			policy.PrivateDataBlockedError
		);
		expect(() => policy.assertModelAllowed(db, fx.trusted, p)).not.toThrow();
	});

	it("treats a private agent's runs as private", () => {
		const db = getDb();
		const agent = createAgent(db, fx.userId, {
			name: 'a',
			systemPrompt: 'x',
			triggerType: 'manual'
		});
		const run = createAgentRun(db, { agentId: agent.id, userId: fx.userId, trigger: 'manual' });
		expect(policy.isPrivateContext(db, { tainted: false, agentRunId: run.id })).toBe(false);
		db.prepare('UPDATE agents SET private = 1 WHERE id = ?').run(agent.id);
		expect(policy.isPrivateContext(db, { tainted: false, agentRunId: run.id })).toBe(true);
	});
});
