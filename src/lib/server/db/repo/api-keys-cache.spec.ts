import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@node-rs/argon2', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@node-rs/argon2')>();
	return { ...actual, verify: vi.fn(actual.verify) };
});

const { verify } = await import('@node-rs/argon2');
const { openDatabase } = await import('../index.js');
const { createApiKey, deleteApiKey, resolveApiKey } = await import('./api-keys.js');

let db: ReturnType<typeof openDatabase>;

beforeEach(() => {
	db = openDatabase(':memory:');
	db.prepare(
		`INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role)
		 VALUES ('u1', 'a@b.c', 'A', 0, 0, 0, 'user')`
	).run();
	vi.mocked(verify).mockClear();
});

describe('api key verification cache', () => {
	it('skips argon2 for a recently verified key', async () => {
		const { rawKey, row } = await createApiKey(db, { userId: 'u1', label: 'ci' });
		expect((await resolveApiKey(db, rawKey))?.id).toBe(row.id);
		expect((await resolveApiKey(db, rawKey))?.id).toBe(row.id);
		expect(verify).toHaveBeenCalledTimes(1);
	});

	it('does not cache failures', async () => {
		const { rawKey } = await createApiKey(db, { userId: 'u1', label: 'ci' });
		const wrong = rawKey.slice(0, -2) + 'zz';
		expect(await resolveApiKey(db, wrong)).toBeNull();
		expect(await resolveApiKey(db, wrong)).toBeNull();
		expect(verify).toHaveBeenCalledTimes(2);
	});

	it('stops accepting a key once it is deleted', async () => {
		const { rawKey, row } = await createApiKey(db, { userId: 'u1', label: 'ci' });
		expect(await resolveApiKey(db, rawKey)).not.toBeNull();
		expect(deleteApiKey(db, row.id, 'u1')).toBe(true);
		expect(await resolveApiKey(db, rawKey)).toBeNull();
	});
});
