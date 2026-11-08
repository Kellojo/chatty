import { CronExpressionParser } from 'cron-parser';
import { config } from '../config.js';
import { getDb, type Db } from '../db/index.js';
import {
	claimAgentRun,
	listUsersWithActivitySinceLastRun,
	listDueScheduleAgents,
	listOverridesForAgent,
	type AgentRow
} from '../db/repo/agents.js';
import { createLogger } from '../logger.js';
import { startAgentRun } from './runner.js';

const log = createLogger('agents');

export function isValidCron(cron: string): boolean {
	try {
		CronExpressionParser.parse(cron);
		return true;
	} catch {
		return false;
	}
}

export function computeNextRunAt(cron: string, from: number = Date.now()): number | null {
	try {
		return CronExpressionParser.parse(cron, { currentDate: new Date(from), tz: config.TZ })
			.next()
			.getTime();
	} catch {
		return null;
	}
}

const inFlight = new Set<string>();

export async function tickAgents(
	db: Db = getDb(),
	runAgentFn?: (agentId: string, userId: string) => Promise<unknown>
): Promise<number> {
	const run =
		runAgentFn ??
		((agentId: string, userId: string) =>
			startAgentRun({ agentId, trigger: 'schedule', userId }).then((s) => s.done));
	let started = 0;
	const now = Date.now();
	// Every due agent starts right away instead of after the previous agent's run
	// finished, so one long run can't hold up the rest. The tick still resolves
	// once all are done, but the interval doesn't wait on it, and `inFlight`
	// keeps an agent from overlapping itself across ticks.
	const jobs: Promise<void>[] = [];
	for (const agent of listDueScheduleAgents(db, now)) {
		let cron: string | undefined;
		try {
			cron = (JSON.parse(agent.trigger_config) as { cron?: string }).cron;
		} catch {
			cron = undefined;
		}
		const claimed = claimAgentRun(
			db,
			agent.id,
			agent.next_run_at,
			cron ? computeNextRunAt(cron, now) : null
		);
		if (!claimed || inFlight.has(agent.id)) continue;
		inFlight.add(agent.id);
		started++;
		jobs.push(runScheduledAgent(db, agent, run).finally(() => inFlight.delete(agent.id)));
	}
	await Promise.all(jobs);
	return started;
}

async function runScheduledAgent(
	db: Db,
	agent: AgentRow,
	run: (agentId: string, userId: string) => Promise<unknown>
): Promise<void> {
	const runLogged = async (userId: string) => {
		try {
			await run(agent.id, userId);
		} catch (e) {
			log.error(`Scheduled run of agent ${agent.id} failed`, {
				agentId: agent.id,
				userId,
				error: e instanceof Error ? e.message : String(e)
			});
		}
	};
	if (agent.user_id !== null) return runLogged(agent.user_id);
	// One agent's per-user runs stay sequential; different agents don't wait on
	// each other. One user's failure doesn't skip the users after them.
	let userIds: string[];
	let overrides: Map<string, boolean>;
	try {
		userIds = listUsersWithActivitySinceLastRun(db, agent.id);
		overrides = listOverridesForAgent(db, agent.id);
	} catch (e) {
		log.error(`Failed to list users for scheduled agent ${agent.id}`, {
			agentId: agent.id,
			error: e instanceof Error ? e.message : String(e)
		});
		return;
	}
	for (const userId of userIds) {
		if (overrides.get(userId) ?? agent.enabled === 1) await runLogged(userId);
	}
}

let timer: ReturnType<typeof setInterval> | null = null;

export function stopAgentScheduler(): void {
	if (timer) clearInterval(timer);
	timer = null;
}

export function startAgentScheduler(db: Db = getDb()): void {
	if (timer) return;
	timer = setInterval(() => {
		tickAgents(db).catch((e) =>
			log.error('Agent scheduler tick failed', {
				error: e instanceof Error ? e.message : String(e)
			})
		);
	}, 30_000);
	timer.unref?.();
	void tickAgents(db).catch((e) =>
		log.error('Agent scheduler tick failed', { error: e instanceof Error ? e.message : String(e) })
	);
}
