// Whether you're at Chatty right now, across devices, so push notices wait
// while the tab in front of you alerts locally. Open tabs report what they
// show and how long ago you last touched them (see $lib/notifications/presence.ts).
//
//   - Around: some tab was touched within the last two minutes, visible or not
//     (switching to your editor hides the window but you're still at the desk).
//     A notice is held while you're around, and pushed once you've stepped away.
//   - Seen: you touched a tab showing the notice's chat after it arrived, even
//     if you've moved on to another chat since. A held notice you've seen is
//     dropped instead of pushed later.
//
// Reports expire, so a tab that goes away or a machine that sleeps stops counting.

/** How long a visible tab's report counts without a fresh heartbeat. */
export const PRESENCE_TTL_MS = 60_000;
/** Input within this window means you're still at the desk. */
export const AROUND_MS = 2 * 60_000;
/** How long to remember when you last touched each chat; covers the longest hold. */
const PATH_MEMORY_MS = 20 * 60_000;

const MAX_CLIENTS_PER_USER = 50;
const MAX_PATHS_PER_USER = 200;

interface ClientPresence {
	expiresAt: number;
	/** When you last touched the tab. */
	lastInputAt: number;
}

interface UserPresence {
	clients: Map<string, ClientPresence>;
	/** Path -> when a tab showing it was last touched. */
	paths: Map<string, number>;
}

export interface PresenceReport {
	/** The path the tab shows, or null while it is hidden or closing. */
	path: string | null;
	/** Milliseconds since you last touched the tab. */
	idleMs: number;
}

const globalState = globalThis as { __pushPresence?: Map<string, UserPresence> };

function state(): Map<string, UserPresence> {
	globalState.__pushPresence ??= new Map();
	return globalState.__pushPresence;
}

export function reportPresence(
	userId: string,
	clientId: string,
	report: PresenceReport,
	now = Date.now()
): void {
	const users = state();
	let user = users.get(userId);
	if (!user) {
		user = { clients: new Map(), paths: new Map() };
		users.set(userId, user);
	}
	prune(user, now);
	const lastInputAt = now - Math.max(0, report.idleMs);
	if (!user.clients.has(clientId) && user.clients.size >= MAX_CLIENTS_PER_USER) {
		dropOldest(user.clients, (c) => c.expiresAt);
	}
	user.clients.set(clientId, {
		// A visible tab heartbeats. A hidden one doesn't, so its report lasts as
		// long as it can still say you're around.
		expiresAt: report.path === null ? lastInputAt + AROUND_MS : now + PRESENCE_TTL_MS,
		lastInputAt
	});
	if (report.path !== null && lastInputAt > (user.paths.get(report.path) ?? 0)) {
		if (!user.paths.has(report.path) && user.paths.size >= MAX_PATHS_PER_USER) {
			dropOldest(user.paths, (at) => at);
		}
		user.paths.set(report.path, lastInputAt);
	}
}

/** Some tab of the user was touched within AROUND_MS. */
export function isUserAround(userId: string, now = Date.now()): boolean {
	const user = live(userId, now);
	if (!user) return false;
	for (const c of user.clients.values()) if (now - c.lastInputAt < AROUND_MS) return true;
	return false;
}

/** You touched a tab showing this path after `since`: you've seen what arrived there. */
export function sawPathSince(
	userId: string,
	path: string,
	since: number,
	now = Date.now()
): boolean {
	return (live(userId, now)?.paths.get(path) ?? 0) > since;
}

function live(userId: string, now: number): UserPresence | undefined {
	const user = state().get(userId);
	if (!user) return undefined;
	prune(user, now);
	if (user.clients.size === 0 && user.paths.size === 0) {
		state().delete(userId);
		return undefined;
	}
	return user;
}

function prune(user: UserPresence, now: number): void {
	for (const [id, c] of user.clients) if (c.expiresAt <= now) user.clients.delete(id);
	for (const [path, at] of user.paths) if (now - at > PATH_MEMORY_MS) user.paths.delete(path);
}

function dropOldest<V>(map: Map<string, V>, age: (v: V) => number): void {
	let oldest: string | null = null;
	let oldestAt = Infinity;
	for (const [k, v] of map) {
		if (age(v) < oldestAt) {
			oldestAt = age(v);
			oldest = k;
		}
	}
	if (oldest !== null) map.delete(oldest);
}

/** Test helper. */
export function resetPresence(): void {
	state().clear();
}
