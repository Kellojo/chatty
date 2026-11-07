// Pulls status + provider usage from each connected coding environment (remote
// T3 Code server) into Chatty's DB. Runs on demand and every SYNC_INTERVAL_MS.

import { config } from '../config.js';
import { decryptSecret } from '../crypto.js';
import { getDb, type Db } from '../db/index.js';
import {
	getCodingEnvironment,
	listEnabledCodingEnvironments,
	recordEnvironmentCheck,
	replaceUsageDaily,
	replaceUsageLimits,
	type CodingEnvironmentRow
} from '../db/repo/coding-environments.js';
import { createLogger } from '../logger.js';
import {
	ORCHESTRATION_PROTOCOL_VERSION,
	T3ClientError,
	connectT3,
	fetchEnvironmentDescriptor
} from './client.js';
import { startThreadSync, stopThreadSync } from './thread-sync.js';
import { dayInZone, parseUsageLimits, parseUsageSummary } from './usage.js';

const log = createLogger('t3-sync');

export const SYNC_INTERVAL_MS = 15 * 60 * 1000;
/** Days of token/cost history requested on each sync (today included). */
export const USAGE_HISTORY_DAYS = 90;

const inFlight = new Map<string, Promise<CodingEnvironmentRow>>();

function errorMessage(e: unknown): string {
	if (e instanceof T3ClientError) return e.message;
	// Don't echo arbitrary internals (paths, addresses) back to the user.
	return 'Unexpected error while syncing';
}

async function runSync(db: Db, env: CodingEnvironmentRow): Promise<void> {
	const descriptor = await fetchEnvironmentDescriptor(env.base_url);
	if (descriptor.orchestrationProtocolVersion !== ORCHESTRATION_PROTOCOL_VERSION) {
		throw new T3ClientError(
			`Unsupported T3 Code protocol v${descriptor.orchestrationProtocolVersion} (Chatty speaks v${ORCHESTRATION_PROTOCOL_VERSION})`,
			'incompatible'
		);
	}

	const connection = await connectT3(env.base_url, decryptSecret(env.token_enc));
	try {
		const serverConfig = await connection.call('server.getConfig', {});
		const limits = parseUsageLimits(serverConfig);

		const now = Date.now();
		const untilDay = dayInZone(now, config.TZ);
		const sinceDay = dayInZone(now - (USAGE_HISTORY_DAYS - 1) * 86_400_000, config.TZ);
		const summary = parseUsageSummary(
			await connection.call('server.getUsageSummary', {
				sinceDay,
				untilDay,
				timeZone: config.TZ,
				resolution: 'day'
			})
		);

		db.transaction(() => {
			replaceUsageLimits(db, env.id, limits);
			replaceUsageDaily(
				db,
				env.id,
				{ fromDay: summary.sinceDay ?? sinceDay, toDay: summary.untilDay ?? untilDay },
				summary.rows
			);
		})();
		recordEnvironmentCheck(db, env.id, {
			status: 'online',
			serverVersion: descriptor.serverVersion,
			environmentLabel: descriptor.label,
			synced: true
		});
	} finally {
		connection.close();
	}
}

/**
 * Connects to the environment, refreshes its status and usage, and returns the
 * updated row. Never throws: failures are recorded on the row (previously synced
 * usage is kept). Concurrent calls for the same environment share one sync.
 */
export function syncCodingEnvironment(
	db: Db,
	env: CodingEnvironmentRow
): Promise<CodingEnvironmentRow> {
	const existing = inFlight.get(env.id);
	if (existing) return existing;
	const promise = (async () => {
		try {
			await runSync(db, env);
		} catch (e) {
			log.warn('Coding environment sync failed', {
				environmentId: env.id,
				error: e instanceof Error ? e.message : String(e)
			});
			recordEnvironmentCheck(db, env.id, { status: 'error', error: errorMessage(e) });
		}
		return getCodingEnvironment(db, env.user_id, env.id) ?? env;
	})().finally(() => inFlight.delete(env.id));
	inFlight.set(env.id, promise);
	return promise;
}

export async function syncAllCodingEnvironments(db: Db = getDb()): Promise<void> {
	for (const env of listEnabledCodingEnvironments(db)) {
		await syncCodingEnvironment(db, env);
	}
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startCodingEnvironmentSync(db: Db = getDb()): void {
	if (timer) return;
	const tick = () => {
		syncAllCodingEnvironments(db).catch((e) =>
			log.error('Coding environment sync failed', {
				error: e instanceof Error ? e.message : String(e)
			})
		);
	};
	tick();
	timer = setInterval(tick, SYNC_INTERVAL_MS);
	timer.unref?.();
	startThreadSync(db);
}

export function stopCodingEnvironmentSync(): void {
	if (timer) clearInterval(timer);
	timer = null;
	stopThreadSync();
}
