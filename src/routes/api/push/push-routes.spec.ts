import { beforeEach, describe, expect, it } from 'vitest';
import { isHttpError } from '@sveltejs/kit';

process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

const { closeDb, getDb } = await import('$lib/server/db/index.js');
const { listPushSubscriptions } = await import('$lib/server/db/repo/push-subscriptions.js');
const { isUserAround, resetPresence, sawPathSince } = await import('$lib/server/push/presence.js');
const subscription = await import('./subscription/+server.js');
const presence = await import('./presence/+server.js');
const keyRoute = await import('./+server.js');

type User = { id: string } | null;
type Handler = (event: never) => Response | Promise<Response>;

const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/device-1';
const SUB = { endpoint: ENDPOINT, keys: { p256dh: 'p', auth: 'a' } };
const u1 = { id: 'u1' };
const u2 = { id: 'u2' };

async function call(
	handler: Handler,
	user: User,
	init: { method: string; body?: string; contentType?: string; query?: string }
): Promise<{ status: number; body: Record<string, unknown> }> {
	const url = new URL(`http://localhost/api/push/x${init.query ?? ''}`);
	const event = {
		locals: {
			user,
			session: user ? { id: `s-${user.id}` } : null
		} as unknown as App.Locals,
		params: {},
		url,
		request: new Request(url, {
			method: init.method,
			headers: init.body
				? { 'content-type': init.contentType ?? 'application/json', 'user-agent': 'test' }
				: undefined,
			body: init.body
		})
	};
	try {
		const res = await handler(event as never);
		return { status: res.status, body: (await res.json()) as Record<string, unknown> };
	} catch (e) {
		if (isHttpError(e))
			return { status: e.status, body: e.body as unknown as Record<string, unknown> };
		throw e;
	}
}

const json = (value: unknown) => JSON.stringify(value);

beforeEach(() => {
	closeDb();
	resetPresence();
	const db = getDb();
	db.prepare(
		`INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role) VALUES
		 ('u1', 'a@b.c', 'A', 0, 0, 0, 'user'), ('u2', 'b@b.c', 'B', 0, 0, 0, 'user')`
	).run();
	db.prepare(
		`INSERT INTO "session" (id, "expiresAt", token, "createdAt", "updatedAt", "userId") VALUES
		 ('s-u1', '2999-01-01T00:00:00.000Z', 't1', 0, 0, 'u1'),
		 ('s-u2', '2999-01-01T00:00:00.000Z', 't2', 0, 0, 'u2')`
	).run();
});

describe('push routes', () => {
	it('require a signed-in user', async () => {
		expect((await call(keyRoute.GET as Handler, null, { method: 'GET' })).status).toBe(401);
		expect(
			(await call(subscription.PUT as Handler, null, { method: 'PUT', body: json(SUB) })).status
		).toBe(401);
		expect(
			(
				await call(presence.POST as Handler, null, {
					method: 'POST',
					body: json({ clientId: 'tab-12345', path: '/', idleMs: 0 })
				})
			).status
		).toBe(401);
	});

	it('hands out the public key', async () => {
		const res = await call(keyRoute.GET as Handler, u1, { method: 'GET' });
		expect(res.body.publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
	});

	it('registers a device to the session and reports who holds it', async () => {
		const put = await call(subscription.PUT as Handler, u1, { method: 'PUT', body: json(SUB) });
		expect(put).toEqual({ status: 200, body: { ok: true, userId: 'u1' } });
		expect(listPushSubscriptions(getDb(), 'u1')[0].session_id).toBe('s-u1');
		const query = `?endpoint=${encodeURIComponent(ENDPOINT)}`;
		expect((await call(subscription.GET as Handler, u1, { method: 'GET', query })).body).toEqual({
			owner: 'you'
		});
		expect((await call(subscription.GET as Handler, u2, { method: 'GET', query })).body).toEqual({
			owner: 'not-you'
		});
	});

	it('rejects endpoints outside the push services', async () => {
		const res = await call(subscription.PUT as Handler, u1, {
			method: 'PUT',
			body: json({ ...SUB, endpoint: 'https://internal.tailnet/hook' })
		});
		expect(res.status).toBe(400);
	});

	it('will not move a device to another account re-registering on its own', async () => {
		await call(subscription.PUT as Handler, u1, { method: 'PUT', body: json(SUB) });
		const res = await call(subscription.PUT as Handler, u2, {
			method: 'PUT',
			body: json({ ...SUB, owner: 'u1' })
		});
		expect(res.status).toBe(409);
		expect(listPushSubscriptions(getDb(), 'u1')).toHaveLength(1);
		expect(listPushSubscriptions(getDb(), 'u2')).toHaveLength(0);
	});

	it("leaves another user's device alone on DELETE", async () => {
		await call(subscription.PUT as Handler, u1, { method: 'PUT', body: json(SUB) });
		await call(subscription.DELETE as Handler, u2, {
			method: 'DELETE',
			body: json({ endpoint: ENDPOINT })
		});
		expect(listPushSubscriptions(getDb(), 'u1')).toHaveLength(1);
		await call(subscription.DELETE as Handler, u1, {
			method: 'DELETE',
			body: json({ endpoint: ENDPOINT })
		});
		expect(listPushSubscriptions(getDb(), 'u1')).toHaveLength(0);
	});

	it('takes presence reports sent as text/plain (sendBeacon)', async () => {
		const res = await call(presence.POST as Handler, u1, {
			method: 'POST',
			contentType: 'text/plain;charset=UTF-8',
			body: json({ clientId: 'tab-12345', path: '/chat/abc', idleMs: 0 })
		});
		expect(res.status).toBe(200);
		expect(isUserAround('u1')).toBe(true);
		expect(sawPathSince('u1', '/chat/abc', Date.now() - 1_000)).toBe(true);
		const bad = await call(presence.POST as Handler, u1, {
			method: 'POST',
			body: json({ clientId: 'tab-12345', path: 'https://evil.example/', idleMs: 0 })
		});
		expect(bad.status).toBe(400);
	});
});
