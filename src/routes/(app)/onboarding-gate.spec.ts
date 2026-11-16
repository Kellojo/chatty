import { beforeEach, describe, expect, it } from 'vitest';
import { isRedirect } from '@sveltejs/kit';

process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

const { closeDb, getDb } = await import('$lib/server/db/index.js');
const { finishOnboarding, startOnboarding } = await import('$lib/server/db/repo/user-settings.js');
const { load } = await import('./+layout.server.js');

async function visit(path: string) {
	const url = new URL(`http://localhost${path}`);
	try {
		await load({
			locals: { user: { id: 'u1', name: 'A', email: 'a@b.c', role: 'user' } },
			depends: () => undefined,
			url
		} as never);
		return null;
	} catch (e) {
		if (isRedirect(e)) return e.location;
		throw e;
	}
}

beforeEach(() => {
	closeDb();
	getDb()
		.prepare(
			`INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role)
			 VALUES ('u1', 'a@b.c', 'A', 0, 0, 0, 'user')`
		)
		.run();
});

describe('(app) onboarding gate', () => {
	it('lets existing accounts (no onboarding state) straight in', async () => {
		expect(await visit('/')).toBeNull();
	});

	it('sends a new account to /welcome, keeping where it was going', async () => {
		startOnboarding(getDb(), 'u1');
		expect(await visit('/')).toBe('/welcome');
		expect(await visit('/chat/abc?x=1')).toBe(
			`/welcome?next=${encodeURIComponent('/chat/abc?x=1')}`
		);
	});

	it('stops redirecting once onboarding is finished or skipped', async () => {
		startOnboarding(getDb(), 'u1');
		finishOnboarding(getDb(), 'u1', 'skipped');
		expect(await visit('/')).toBeNull();
	});
});
