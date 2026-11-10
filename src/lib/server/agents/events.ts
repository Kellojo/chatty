import {
	AGENT_EVENT_NAMES,
	type AgentEventName,
	type AgentTriggerConfig,
	type ServerEvent
} from '$lib/types.js';
import { getDb, type Db } from '../db/index.js';
import { getAgentRun, isAgentRunConversation, listRunningAgentIds } from '../db/repo/agent-runs.js';
import {
	getAgent,
	incrementAgentEventCounter,
	listEventAgents,
	listOverridesForAgent,
	type AgentRow
} from '../db/repo/agents.js';
import { subscribeAllServerEvents } from '../events/bus.js';
import { createLogger } from '../logger.js';
import { settleCodingAgentRun } from './coding-runs.js';

const log = createLogger('agents');

type RunFn = (agentId: string, userId: string, instructions: string) => Promise<unknown>;

interface Occurrence {
	event: AgentEventName;
	count: number;
	payloadJson: string;
}

interface Pending {
	occurrences: Occurrence[];
	dropped: number;
}

// Events that arrive while their agent is busy are queued and handed to one
// follow-up run when it finishes, instead of being dropped. Bounded per
// agent+user so a noisy event source can't grow without limit.
const MAX_PENDING = 20;

// Loop guard: an agent whose runs keep producing the events it listens to
// (directly or via another agent) is capped at this many event triggers per
// user per window; further occurrences are dropped.
const MAX_TRIGGERS_PER_WINDOW = 10;
const TRIGGER_WINDOW_MS = 60_000;
/** `${agentId}:${userId}` → recent trigger timestamps. */
const recentTriggers = new Map<string, number[]>();

function overTriggerLimit(agentId: string, userId: string, now = Date.now()): boolean {
	const key = `${agentId}:${userId}`;
	const times = (recentTriggers.get(key) ?? []).filter((t) => t > now - TRIGGER_WINDOW_MS);
	if (times.length >= MAX_TRIGGERS_PER_WINDOW) {
		recentTriggers.set(key, times);
		return true;
	}
	times.push(now);
	recentTriggers.set(key, times);
	// Keep the map bounded by the agents active in the last window.
	if (recentTriggers.size > 1000) {
		for (const [k, ts] of recentTriggers) {
			if (!ts.some((t) => t > now - TRIGGER_WINDOW_MS)) recentTriggers.delete(k);
		}
	}
	return false;
}

/** True when the event was caused by a run of this same agent (e.g. its own memory write). */
function fromOwnRun(db: Db, agentId: string, payload: Record<string, unknown>): boolean {
	const runId = payload.agentRunId;
	return typeof runId === 'string' && getAgentRun(db, runId)?.agent_id === agentId;
}

/** Agents with a run being started or running from this dispatcher. */
const dispatching = new Set<string>();
/** agentId → userId → occurrences waiting for the agent to become free. */
const pending = new Map<string, Map<string, Pending>>();

const defaultRun: RunFn = (agentId, userId, instructions) =>
	import('./runner.js')
		.then((m) => m.startAgentRun({ agentId, trigger: 'event', userId, instructions }))
		.then((s) => s.done);

function enabledFor(db: Db, agent: AgentRow, userId: string): boolean {
	if (agent.user_id !== null) return agent.user_id === userId && agent.enabled === 1;
	return listOverridesForAgent(db, agent.id).get(userId) ?? agent.enabled === 1;
}

function parseTriggerConfig(agent: AgentRow): AgentTriggerConfig {
	try {
		return JSON.parse(agent.trigger_config) as AgentTriggerConfig;
	} catch {
		return {};
	}
}

function describeOccurrence(o: Occurrence): string {
	return `"${o.event}" (occurrence #${o.count}). Payload: ${o.payloadJson}`;
}

/**
 * Coding agents ignore events about conversations that agent runs created
 * (their own tasks included): a coding agent on `coding.thread.finished` or
 * `chat.created` would otherwise trigger itself, or another coding agent, in
 * an endless, costly loop.
 */
function fromAgentRun(db: Db, payload: Record<string, unknown>): boolean {
	const conversationId = payload.conversationId;
	return typeof conversationId === 'string' && isAgentRunConversation(db, conversationId);
}

/**
 * No agent reacts to events from conversations that exist for agent runs:
 * hidden run transcripts and the chats Chatty dispatches for runs (replies in
 * them included). Otherwise an agent on `chat.*` events would trigger itself or
 * another agent in a loop. Coding agents additionally skip coding run chats
 * (`fromAgentRun`), which are ordinary user chats for everyone else.
 */
function fromRunConversation(db: Db, payload: Record<string, unknown>): boolean {
	const conversationId = payload.conversationId;
	if (typeof conversationId !== 'string') return false;
	return (
		db
			.prepare(
				`SELECT 1 FROM conversations WHERE id = ? AND (kind = 'agent-run' OR origin = 'dispatch')`
			)
			.get(conversationId) !== undefined
	);
}

export function buildEventInstructions(
	triggerConfig: AgentTriggerConfig,
	occurrences: Occurrence[],
	dropped = 0
): string {
	if (occurrences.length === 1 && dropped === 0) {
		const [o] = occurrences;
		return triggerConfig.instructions
			? `${triggerConfig.instructions}\n\nTriggering event: ${describeOccurrence(o)}`
			: `The event "${o.event}" just occurred (occurrence #${o.count}). Payload: ${o.payloadJson}. Act on it according to your role.`;
	}
	const list = occurrences.map((o) => `- ${describeOccurrence(o)}`).join('\n');
	const note = dropped > 0 ? `\n(${dropped} earlier occurrence(s) were dropped.)` : '';
	return triggerConfig.instructions
		? `${triggerConfig.instructions}\n\nTriggering events:\n${list}${note}`
		: `These events occurred:\n${list}${note}\nAct on them according to your role.`;
}

function isBusy(db: Db, agentId: string): boolean {
	return dispatching.has(agentId) || listRunningAgentIds(db, [agentId]).length > 0;
}

function enqueue(agentId: string, userId: string, occurrence: Occurrence): void {
	let byUser = pending.get(agentId);
	if (!byUser) pending.set(agentId, (byUser = new Map()));
	let entry = byUser.get(userId);
	if (!entry) byUser.set(userId, (entry = { occurrences: [], dropped: 0 }));
	entry.occurrences.push(occurrence);
	if (entry.occurrences.length > MAX_PENDING) {
		entry.occurrences.shift();
		entry.dropped++;
	}
}

// Claims the agent synchronously, before any await, so two events in the same
// tick can't both start a run. The run itself isn't awaited: one long run must
// not hold up dispatch to other agents.
function dispatch(db: Db, agentId: string, userId: string, instructions: string, run: RunFn): void {
	dispatching.add(agentId);
	let started: Promise<unknown>;
	try {
		started = run(agentId, userId, instructions);
	} catch (e) {
		started = Promise.reject(e);
	}
	void started
		.catch((e) =>
			log.error(`Event run of agent ${agentId} failed`, {
				agentId,
				error: e instanceof Error ? e.message : String(e)
			})
		)
		.finally(() => {
			dispatching.delete(agentId);
			drainAgent(agentId, db, run);
		});
}

/** Starts a follow-up run for queued events once the agent is free. */
export function drainAgent(agentId: string, db: Db = getDb(), run: RunFn = defaultRun): void {
	try {
		const byUser = pending.get(agentId);
		if (!byUser || isBusy(db, agentId)) return;
		const next = byUser.entries().next();
		if (next.done) return;
		const [userId, entry] = next.value;
		byUser.delete(userId);
		if (byUser.size === 0) pending.delete(agentId);
		const agent = getAgent(db, agentId);
		// The agent may have been deleted, disabled or retargeted meanwhile.
		if (!agent || agent.trigger_type !== 'event' || !enabledFor(db, agent, userId)) {
			drainAgent(agentId, db, run);
			return;
		}
		const instructions = buildEventInstructions(
			parseTriggerConfig(agent),
			entry.occurrences,
			entry.dropped
		);
		dispatch(db, agentId, userId, instructions, run);
	} catch (e) {
		log.error(`Failed to drain queued events for agent ${agentId}`, {
			agentId,
			error: e instanceof Error ? e.message : String(e)
		});
	}
}

export async function emitAgentEvent(
	event: AgentEventName,
	userId: string,
	payload: Record<string, unknown>,
	db: Db = getDb(),
	runFn?: RunFn
): Promise<void> {
	try {
		const run = runFn ?? defaultRun;
		if (fromRunConversation(db, payload)) return;
		for (const agent of listEventAgents(db, event)) {
			try {
				if (!enabledFor(db, agent, userId)) continue;
				if (agent.coding_target && fromAgentRun(db, payload)) continue;
				if (fromOwnRun(db, agent.id, payload)) continue;
				const count = incrementAgentEventCounter(db, agent.id, userId, event);
				const triggerConfig = parseTriggerConfig(agent);
				const rawEvery = triggerConfig.every;
				const every =
					typeof rawEvery === 'number' && Number.isFinite(rawEvery)
						? Math.max(1, Math.trunc(rawEvery))
						: 1;
				if (count % every !== 0) continue;
				if (overTriggerLimit(agent.id, userId)) {
					log.warn(`Agent ${agent.id} hit its event trigger limit; dropping "${event}"`, {
						agentId: agent.id,
						event
					});
					continue;
				}
				const occurrence: Occurrence = { event, count, payloadJson: JSON.stringify(payload) };
				const queued = pending.get(agent.id)?.get(userId);
				if (isBusy(db, agent.id) || queued) {
					// Keep order: anything already queued for this user goes first.
					enqueue(agent.id, userId, occurrence);
					drainAgent(agent.id, db, run);
					continue;
				}
				dispatch(db, agent.id, userId, buildEventInstructions(triggerConfig, [occurrence]), run);
			} catch (e) {
				log.error(`Event run of agent ${agent.id} failed`, {
					agentId: agent.id,
					event,
					error: e instanceof Error ? e.message : String(e)
				});
			}
		}
	} catch (e) {
		log.error(`Failed to emit agent event ${event}`, {
			event,
			error: e instanceof Error ? e.message : String(e)
		});
	}
}

export function handleServerEvent(
	userId: string,
	event: ServerEvent,
	db: Db = getDb(),
	runFn?: RunFn
): void {
	// Runs started elsewhere (schedule, manual, HTTP) also block event runs;
	// their completion is the signal to process what queued up meanwhile.
	if (event.type === 'agent.run.finished') {
		if (pending.has(event.agentId)) drainAgent(event.agentId, db, runFn);
		return;
	}
	// Settle a coding agent's run before other agents react to its thread ending.
	if (event.type === 'coding.thread.finished') settleCodingAgentRun(event, db);
	if (!(AGENT_EVENT_NAMES as readonly string[]).includes(event.type)) return;
	const { type, ...payload } = event;
	void emitAgentEvent(type as AgentEventName, userId, payload, db, runFn);
}

export function startAgentEventDispatcher(): void {
	const globalFlag = globalThis as { __agentEventDispatcherStarted?: boolean };
	if (globalFlag.__agentEventDispatcherStarted) return;
	globalFlag.__agentEventDispatcherStarted = true;
	subscribeAllServerEvents((userId, event) => handleServerEvent(userId, event));
}
