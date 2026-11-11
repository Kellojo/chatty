import { stopAllAgentRuns } from './agents/runner.js';
import { stopAgentScheduler } from './agents/scheduler.js';
import { abortStreamAndWait, listActiveStreamIds } from './chat/streams.js';
import { closeDb } from './db/index.js';
import { stopDailyJobs, stopHourlyJobs } from './jobs.js';
import { createLogger } from './logger.js';
import { closeAllMcpClients } from './mcp/pool.js';
import { stopPushDispatcher } from './push/dispatcher.js';
import { prepareCodingShutdown, stopAllCodingFollowers } from './t3/follower.js';
import { closeAllPreviewViewers } from './t3/preview.js';
import { stopCodingEnvironmentSync } from './t3/sync.js';

const log = createLogger('server');

// Must stay well under Docker's default 10s between SIGTERM and SIGKILL.
const DRAIN_TIMEOUT_MS = 5000;

let draining: Promise<void> | null = null;

/** Stops background work and lets running responses save their output. Idempotent. */
export function drainForShutdown(): Promise<void> {
	draining ??= (async () => {
		stopAgentScheduler();
		stopDailyJobs();
		stopHourlyJobs();
		stopPushDispatcher();
		stopCodingEnvironmentSync();
		// Coding agents run remotely and must keep going; only detach from them.
		prepareCodingShutdown();
		// Preview streams never end on their own (heartbeats keep them open).
		closeAllPreviewViewers();
		await Promise.all([
			...listActiveStreamIds().map((id) => abortStreamAndWait(id, 'shutdown', DRAIN_TIMEOUT_MS)),
			stopAllAgentRuns(DRAIN_TIMEOUT_MS)
		]);
		stopAllCodingFollowers();
		// After the drain: running turns may still be calling pooled MCP tools.
		await closeAllMcpClients();
	})().catch((e) => {
		log.error('Failed to drain running work on shutdown', {
			error: e instanceof Error ? e.message : String(e)
		});
	});
	return draining;
}

/**
 * adapter-node handles the signals itself by closing the HTTP server, then emits
 * `sveltekit:shutdown` once all connections have ended. Draining has to start on
 * the signal: open response streams are what keep those connections alive.
 */
export function registerShutdownHandlers(): void {
	const globalFlag = globalThis as { __shutdownHandlersRegistered?: boolean };
	if (globalFlag.__shutdownHandlersRegistered) return;
	globalFlag.__shutdownHandlersRegistered = true;

	const onSignal = () => void drainForShutdown();
	process.once('SIGTERM', onSignal);
	process.once('SIGINT', onSignal);
	process.once('sveltekit:shutdown' as never, async () => {
		await drainForShutdown();
		closeDb();
		log.info('Shutdown complete');
	});
}
