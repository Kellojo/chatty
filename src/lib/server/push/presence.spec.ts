import { beforeEach, describe, expect, it } from 'vitest';
import {
	AROUND_MS,
	PRESENCE_TTL_MS,
	isUserAround,
	reportPresence,
	resetPresence,
	sawPathSince
} from './presence.js';

describe('push presence', () => {
	beforeEach(() => resetPresence());

	it('is around while a tab was touched in the last two minutes', () => {
		expect(isUserAround('u1', 0)).toBe(false);
		reportPresence('u1', 'tab', { path: '/chat/1', idleMs: 0 }, 0);
		expect(isUserAround('u1', 1)).toBe(true);
		expect(isUserAround('u2', 1)).toBe(false);
		// Keeps heartbeating, but nobody touches it.
		reportPresence('u1', 'tab', { path: '/chat/1', idleMs: AROUND_MS }, AROUND_MS);
		expect(isUserAround('u1', AROUND_MS)).toBe(false);
	});

	it('still counts you around after the window is hidden (switched to another app)', () => {
		reportPresence('u1', 'tab', { path: null, idleMs: 5_000 }, 10_000);
		expect(isUserAround('u1', 10_000 + PRESENCE_TTL_MS)).toBe(true);
		expect(isUserAround('u1', 5_000 + AROUND_MS)).toBe(false);
	});

	it('forgets a visible tab that stops heartbeating', () => {
		reportPresence('u1', 'tab', { path: '/', idleMs: 0 }, 0);
		expect(isUserAround('u1', PRESENCE_TTL_MS)).toBe(false);
	});

	it('remembers touching a chat after moving on to another', () => {
		reportPresence('u1', 'tab', { path: '/chat/1', idleMs: 0 }, 1_000);
		reportPresence('u1', 'tab', { path: '/chat/2', idleMs: 0 }, 2_000);
		expect(sawPathSince('u1', '/chat/1', 500, 3_000)).toBe(true);
		expect(sawPathSince('u1', '/chat/1', 1_500, 3_000)).toBe(false);
		expect(sawPathSince('u1', '/chat/3', 0, 3_000)).toBe(false);
	});

	it('counts the time of the input, not of the report', () => {
		// On screen but untouched since before the notice arrived at t=5000.
		reportPresence('u1', 'tab', { path: '/chat/1', idleMs: 10_000 }, 12_000);
		expect(sawPathSince('u1', '/chat/1', 5_000, 12_000)).toBe(false);
	});
});
