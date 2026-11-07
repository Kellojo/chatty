import { describe, expect, it, vi } from 'vitest';

process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

const stopAllAgentRuns = vi.fn(async () => undefined);
const stopAgentScheduler = vi.fn();
const stopDailyJobs = vi.fn();
const stopHourlyJobs = vi.fn();
const stopCodingEnvironmentSync = vi.fn();
const closeDb = vi.fn();

vi.mock('./agents/runner.js', () => ({ stopAllAgentRuns }));
vi.mock('./agents/scheduler.js', () => ({ stopAgentScheduler }));
vi.mock('./jobs.js', () => ({ stopDailyJobs, stopHourlyJobs }));
vi.mock('./db/index.js', () => ({ closeDb }));
vi.mock('./t3/sync.js', () => ({ stopCodingEnvironmentSync }));
vi.mock('./t3/follower.js', () => ({
	prepareCodingShutdown: vi.fn(),
	stopAllCodingFollowers: vi.fn()
}));

const { registerStream, releaseStream } = await import('./chat/streams.js');
const { registerShutdownHandlers } = await import('./shutdown.js');

describe('shutdown', () => {
	it('drains running work before closing the database', async () => {
		registerShutdownHandlers();

		// The stream persists its output a moment after being aborted; the database
		// must still be open at that point.
		const controller = new AbortController();
		registerStream('c1', controller);
		let closedBeforeRelease = false;
		controller.signal.addEventListener('abort', () => {
			setTimeout(() => {
				closedBeforeRelease = closeDb.mock.calls.length > 0;
				releaseStream('c1', controller);
			}, 20);
		});

		process.emit('sveltekit:shutdown' as never);
		await vi.waitFor(() => expect(closeDb).toHaveBeenCalledOnce());

		expect(controller.signal.aborted).toBe(true);
		expect(closedBeforeRelease).toBe(false);
		expect(stopAllAgentRuns).toHaveBeenCalledOnce();
		expect(stopAgentScheduler).toHaveBeenCalledOnce();
		expect(stopDailyJobs).toHaveBeenCalledOnce();
		expect(stopHourlyJobs).toHaveBeenCalledOnce();
		expect(stopCodingEnvironmentSync).toHaveBeenCalledOnce();
	});
});
