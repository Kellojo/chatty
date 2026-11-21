import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { isMemoryRunActive, onMemoryRunSettled, trackMemoryRun } from './memory-runs.js';

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => (resolve = r));
	return { promise, resolve };
}

describe('trackMemoryRun', () => {
	it('keeps the run active until its done settles', async () => {
		const agentId = randomUUID();
		const gate = deferred();
		const started = await trackMemoryRun(agentId, 'u1', async () => ({
			run: 'r1',
			done: gate.promise
		}));
		expect(started.run).toBe('r1');
		expect(isMemoryRunActive(agentId, 'u1')).toBe(true);
		expect(isMemoryRunActive(agentId, 'u2')).toBe(false);
		gate.resolve();
		await started.done;
		expect(isMemoryRunActive(agentId, 'u1')).toBe(false);
	});

	it('stays active while an overlapping run of the same agent is in progress', async () => {
		const agentId = randomUUID();
		const first = deferred();
		const second = deferred();
		const a = await trackMemoryRun(agentId, 'u1', async () => ({ run: 1, done: first.promise }));
		const b = await trackMemoryRun(agentId, 'u1', async () => ({ run: 2, done: second.promise }));
		first.resolve();
		await a.done;
		expect(isMemoryRunActive(agentId, 'u1')).toBe(true);
		second.resolve();
		await b.done;
		expect(isMemoryRunActive(agentId, 'u1')).toBe(false);
	});

	it('releases the run when starting it throws', async () => {
		const agentId = randomUUID();
		await expect(
			trackMemoryRun(agentId, 'u1', async () => {
				throw new Error('no workspace');
			})
		).rejects.toThrow('no workspace');
		expect(isMemoryRunActive(agentId, 'u1')).toBe(false);
	});

	it('tells listeners once the run is no longer active, and survives a failing one', async () => {
		const agentId = randomUUID();
		const seen: boolean[] = [];
		const offBad = onMemoryRunSettled(() => {
			throw new Error('listener bug');
		});
		const off = onMemoryRunSettled(() => seen.push(isMemoryRunActive(agentId, 'u1')));
		const listener = vi.fn();
		const offSpy = onMemoryRunSettled(listener);
		try {
			const started = await trackMemoryRun(agentId, 'u1', async () => ({
				run: null,
				done: Promise.resolve()
			}));
			await started.done;
			expect(seen).toEqual([false]);
			expect(listener).toHaveBeenCalledTimes(1);
		} finally {
			offBad();
			off();
			offSpy();
		}
	});
});
