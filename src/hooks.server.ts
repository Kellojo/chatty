import type { Handle } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import { building } from '$app/environment';
import { svelteKitHandler } from 'better-auth/svelte-kit';
import { auth } from '$lib/server/auth/index.js';
import { seedBuiltinAgent, seedMemoryCleanupAgent } from '$lib/server/agents/builtin.js';
import { startAgentEventDispatcher } from '$lib/server/agents/events.js';
import { startAgentScheduler } from '$lib/server/agents/scheduler.js';
import { getDb } from '$lib/server/db/index.js';
import { failRunningAgentRuns } from '$lib/server/db/repo/agent-runs.js';
import { failRunningProxyRequests } from '$lib/server/db/repo/proxy-requests.js';
import { startDailyJobs } from '$lib/server/jobs.js';
import { createLogger } from '$lib/server/logger.js';
import { reconcileMemoryFts } from '$lib/server/memory/fts.js';
import { seedDefaultSkills } from '$lib/server/skills/defaults.js';

const log = createLogger('server');

if (!building) {
	try {
		seedBuiltinAgent(getDb());
		seedMemoryCleanupAgent(getDb());
		const interrupted = failRunningAgentRuns(getDb());
		if (interrupted > 0) {
			log.warn(`Marked ${interrupted} interrupted agent run(s) as failed`);
		}
		const interruptedProxy = failRunningProxyRequests(getDb());
		if (interruptedProxy > 0) {
			log.warn(`Marked ${interruptedProxy} interrupted proxy request(s) as failed`);
		}
	} catch (e) {
		log.error('Failed to seed builtin agent or clean up runs:', {
			message: e instanceof Error ? e.message : String(e)
		});
	}
	setTimeout(() => {
		try {
			const { upserted, removed } = reconcileMemoryFts(getDb());
			if (upserted > 0 || removed > 0) {
				log.info(`Memory index reconciled: ${upserted} upserted, ${removed} removed`);
			}
		} catch (e) {
			log.error('Failed to reconcile memory FTS:', {
				message: e instanceof Error ? e.message : String(e)
			});
		}
	}, 0);
	seedDefaultSkills();
	startAgentEventDispatcher();
	startAgentScheduler(getDb());
	startDailyJobs(getDb());
}

const authRoutes: Handle = ({ event, resolve }) =>
	svelteKitHandler({ event, resolve, auth, building });

const sessionHandle: Handle = async ({ event, resolve }) => {
	const session = await auth.api.getSession({ headers: event.request.headers });
	event.locals.session = session?.session ?? null;
	event.locals.user = session?.user ?? null;
	return resolve(event);
};

export const handle: Handle = sequence(authRoutes, sessionHandle);
