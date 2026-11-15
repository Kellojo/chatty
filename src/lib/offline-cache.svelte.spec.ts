// Browser project (real Cache Storage and localStorage), hence `.svelte.spec`.
import { afterEach, describe, expect, it } from 'vitest';
import { USER_DATA_CACHES, claimUserDataCaches, clearUserDataCaches } from './offline-cache.js';

const names = Object.values(USER_DATA_CACHES);

async function fillCaches(): Promise<void> {
	for (const name of names) {
		const cache = await caches.open(name);
		await cache.put(`/fixture/${name}`, new Response('secret transcript'));
	}
}

const cached = async () => (await caches.keys()).filter((key) => names.includes(key as never));

describe('offline-cache', () => {
	afterEach(async () => {
		await clearUserDataCaches();
		await caches.delete('unrelated');
	});

	it('clears every account cache and leaves other caches alone', async () => {
		await fillCaches();
		await (await caches.open('unrelated')).put('/x', new Response('keep'));
		await clearUserDataCaches();
		expect(await cached()).toEqual([]);
		expect(await caches.has('unrelated')).toBe(true);
	});

	it('keeps the caches for the same account and clears them for another', async () => {
		await claimUserDataCaches('user-a');
		await fillCaches();
		await claimUserDataCaches('user-a');
		expect((await cached()).sort()).toEqual([...names].sort());

		await claimUserDataCaches('user-b');
		expect(await cached()).toEqual([]);
	});

	it('clears caches no account was recorded for', async () => {
		await fillCaches();
		await claimUserDataCaches('user-a');
		expect(await cached()).toEqual([]);
	});

	it('forgets the owner on clear, so the next sign-in starts empty', async () => {
		await claimUserDataCaches('user-a');
		await clearUserDataCaches();
		await fillCaches();
		await claimUserDataCaches('user-a');
		expect(await cached()).toEqual([]);
	});
});
