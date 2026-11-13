import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({
	invalidate: vi.fn(async () => {}),
	invalidateAll: vi.fn(async () => {})
}));
const state = vi.hoisted(() => ({ navigating: { to: null as unknown } }));

vi.mock('$app/navigation', () => navigation);
vi.mock('$app/state', () => state);

const { invalidateWhenIdle, scheduleInvalidate } = await import('./invalidate-when-idle.js');

describe('invalidateWhenIdle', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		navigation.invalidate.mockClear();
		navigation.invalidateAll.mockClear();
		state.navigating.to = null;
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('invalidates right away when nothing is navigating', async () => {
		await invalidateWhenIdle('app:x');
		expect(navigation.invalidate).toHaveBeenCalledWith('app:x');
		expect(navigation.invalidateAll).not.toHaveBeenCalled();
	});

	it('waits for a navigation to finish, then runs once', async () => {
		state.navigating.to = {};
		const done = invalidateWhenIdle('app:x');
		void invalidateWhenIdle('app:x');
		await vi.advanceTimersByTimeAsync(200);
		expect(navigation.invalidate).not.toHaveBeenCalled();
		state.navigating.to = null;
		await vi.advanceTimersByTimeAsync(100);
		await done;
		expect(navigation.invalidate).toHaveBeenCalledTimes(1);
	});
});

describe('scheduleInvalidate', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		navigation.invalidate.mockClear();
		navigation.invalidateAll.mockClear();
		state.navigating.to = null;
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('runs requests made close together as one invalidation', async () => {
		const first = scheduleInvalidate('app:x');
		await vi.advanceTimersByTimeAsync(100);
		const second = scheduleInvalidate('app:x');
		expect(second).toBe(first);
		await vi.advanceTimersByTimeAsync(100);
		await first;
		expect(navigation.invalidate).toHaveBeenCalledTimes(1);
	});

	it('lets a full reload cover the keyed ones', async () => {
		const done = scheduleInvalidate('app:x');
		void scheduleInvalidate();
		await vi.advanceTimersByTimeAsync(200);
		await done;
		expect(navigation.invalidateAll).toHaveBeenCalledTimes(1);
		expect(navigation.invalidate).not.toHaveBeenCalled();
	});

	it('starts a new batch after the last one ran', async () => {
		void scheduleInvalidate('app:x');
		await vi.advanceTimersByTimeAsync(200);
		void scheduleInvalidate('app:x');
		await vi.advanceTimersByTimeAsync(200);
		expect(navigation.invalidate).toHaveBeenCalledTimes(2);
	});
});
