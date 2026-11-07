import { describe, expect, it, vi } from 'vitest';
import { coalesce } from './coalesce.js';

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => (resolve = r));
	return { promise, resolve };
}

describe('coalesce', () => {
	it('runs once when called while idle', async () => {
		let calls = 0;
		const run = coalesce(async () => {
			calls++;
		});
		await run();
		expect(calls).toBe(1);
	});

	it('folds calls made during a run into a single follow-up run', async () => {
		const gates = [deferred(), deferred()];
		let calls = 0;
		let concurrent = 0;
		let maxConcurrent = 0;
		const run = coalesce(async () => {
			const gate = gates[calls++];
			concurrent++;
			maxConcurrent = Math.max(maxConcurrent, concurrent);
			await gate?.promise;
			concurrent--;
		});

		const first = run();
		const second = run();
		const third = run();
		expect(calls).toBe(1);
		gates[0].resolve();
		await vi.waitFor(() => expect(calls).toBe(2));
		gates[1].resolve();
		await Promise.all([first, second, third]);
		expect(calls).toBe(2);
		expect(maxConcurrent).toBe(1);
	});

	it('still runs the follow-up when a run fails, and recovers afterwards', async () => {
		const gate = deferred();
		let calls = 0;
		const run = coalesce(async () => {
			calls++;
			if (calls === 1) {
				await gate.promise;
				throw new Error('first failed');
			}
		});
		const first = run();
		const second = run();
		gate.resolve();
		await expect(Promise.all([first, second])).resolves.toBeDefined();
		expect(calls).toBe(2);
		await run();
		expect(calls).toBe(3);
	});

	it('rejects when the last run fails', async () => {
		const run = coalesce(async () => {
			throw new Error('boom');
		});
		await expect(run()).rejects.toThrow('boom');
	});
});
