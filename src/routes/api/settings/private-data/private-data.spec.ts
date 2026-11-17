import { isHttpError } from '@sveltejs/kit';
import { beforeEach, describe, expect, it } from 'vitest';

process.env.DATABASE_PATH = ':memory:';

const { closeDb, getDb } = await import('$lib/server/db/index.js');
const { isPrivateDataEnabled } = await import('$lib/server/privacy/feature.js');
const { privateDataStatus } = await import('$lib/server/privacy/status.js');
const { PUT } = await import('./+server.js');

async function put(role: string, body: unknown): Promise<number> {
	const event = {
		locals: { user: { id: 'u1', role }, session: null },
		request: new Request('http://localhost/api/settings/private-data', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		})
	};
	try {
		return (await PUT(event as never)).status;
	} catch (e) {
		if (isHttpError(e)) return e.status;
		throw e;
	}
}

beforeEach(() => closeDb());

describe('Settings → Private data', () => {
	it('is off until an admin turns it on, and the app shell follows', async () => {
		const db = getDb();
		expect(isPrivateDataEnabled(db)).toBe(false);
		expect(privateDataStatus(db).enabled).toBe(false);
		expect(await put('admin', { privateDataEnabled: true })).toBe(200);
		expect(isPrivateDataEnabled(db)).toBe(true);
		expect(privateDataStatus(db).enabled).toBe(true);
		expect(await put('admin', { privateDataEnabled: false })).toBe(200);
		expect(isPrivateDataEnabled(db)).toBe(false);
	});

	it('is admin-only and validates its body', async () => {
		expect(await put('user', { privateDataEnabled: true })).toBe(403);
		expect(isPrivateDataEnabled(getDb())).toBe(false);
		expect(await put('admin', { privateDataEnabled: 'yes' })).toBe(400);
	});
});
