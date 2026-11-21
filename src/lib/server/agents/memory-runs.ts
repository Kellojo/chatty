/**
 * Built-in memory agent runs that are in progress, from their first pass's
 * start until their last pass ends. A run row only covers one pass, so
 * between the public and the private pass no row is `running`; this closes
 * that gap for the event dispatcher (agents/events.ts), whatever started the
 * run (event, manual, schedule or HTTP).
 *
 * Counted, not a set: two runs of one agent for one user can overlap (a
 * manual start beside an event run), and the first to end must not clear it.
 */

interface MemoryRunState {
	active: Map<string, number>;
	settled: Set<() => void>;
}

// On globalThis, so a dev-server module reload doesn't lose runs in progress.
function state(): MemoryRunState {
	const g = globalThis as { __memoryRuns?: MemoryRunState };
	return (g.__memoryRuns ??= { active: new Map(), settled: new Set() });
}

const keyOf = (agentId: string, userId: string) => `${agentId}:${userId}`;

export function isMemoryRunActive(agentId: string, userId: string): boolean {
	return state().active.has(keyOf(agentId, userId));
}

/** Calls `listener` whenever a memory run ends; returns the unsubscribe. */
export function onMemoryRunSettled(listener: () => void): () => void {
	const { settled } = state();
	settled.add(listener);
	return () => settled.delete(listener);
}

function release(key: string): void {
	const { active, settled } = state();
	const left = (active.get(key) ?? 1) - 1;
	if (left > 0) active.set(key, left);
	else active.delete(key);
	for (const listener of settled) {
		try {
			listener();
		} catch {
			// a listener's failure must not fail the run
		}
	}
}

/**
 * Marks the agent's run for the user active while `start` starts it and
 * until its `done` settles (also when starting it throws).
 */
export async function trackMemoryRun<R, D>(
	agentId: string,
	userId: string,
	start: () => Promise<{ run: R; done: Promise<D> }>
): Promise<{ run: R; done: Promise<D> }> {
	const key = keyOf(agentId, userId);
	const { active } = state();
	active.set(key, (active.get(key) ?? 0) + 1);
	let started: { run: R; done: Promise<D> };
	try {
		started = await start();
	} catch (e) {
		release(key);
		throw e;
	}
	return { run: started.run, done: started.done.finally(() => release(key)) };
}
