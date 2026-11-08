// Pure helpers for a chat's message list when only its newest messages are
// loaded and earlier pages are fetched on demand.

type HasId = { id: string };

/** Prepends an earlier page, skipping any message that is already shown. */
export function prependOlder<T extends HasId>(current: T[], older: T[]): T[] {
	const shown = new Set(current.map((m) => m.id));
	const fresh = older.filter((m) => !shown.has(m.id));
	return fresh.length === 0 ? current : [...fresh, ...current];
}

/**
 * Swaps in a freshly loaded newest page while keeping the earlier pages
 * already loaded in front of it. `keptOlder` is false when nothing before the
 * new page could be kept (it doesn't overlap what was shown), so whether more
 * history exists is then the new page's own answer.
 */
export function withLatestPage<T extends HasId>(
	current: T[],
	latest: T[]
): { messages: T[]; keptOlder: boolean } {
	const first = latest[0];
	const index = first ? current.findIndex((m) => m.id === first.id) : -1;
	if (index <= 0) return { messages: latest, keptOlder: false };
	return { messages: [...current.slice(0, index), ...latest], keptOlder: true };
}

type HasContent = HasId & { role: string; parts: readonly unknown[]; metadata?: unknown };

/** Cheap identity of what a message shows: equal for an unchanged message. */
function contentKey(message: HasContent): string {
	return JSON.stringify([message.role, message.parts, message.metadata ?? null]);
}

/**
 * `next`, but reusing the objects of `current` whose content did not change.
 * Reloads replace every message object otherwise, and an unchanged object
 * keeps the timeline from re-deriving that message's parts. Returns `current`
 * itself when nothing changed at all.
 */
export function reuseUnchanged<T extends HasContent>(current: T[], next: T[]): T[] {
	const byId = new Map(current.map((m) => [m.id, m]));
	let changed = current.length !== next.length;
	const merged = next.map((message, index) => {
		const existing = byId.get(message.id);
		const same = existing !== undefined && contentKey(existing) === contentKey(message);
		const result = same ? existing : message;
		if (result !== current[index]) changed = true;
		return result;
	});
	return changed ? merged : current;
}

type PartLike = { type: string };
type FilePartLike = { type: 'file'; url: string; mediaType: string; filename?: string };

/** A message's text, joined across its text parts. */
export function messageText(message: { parts: readonly PartLike[] }): string {
	return message.parts
		.filter((p): p is PartLike & { type: 'text'; text: string } => p.type === 'text')
		.map((p) => p.text)
		.join('');
}

/** A message's attached files. */
export function messageFiles(message: { parts: readonly PartLike[] }): FilePartLike[] {
	return message.parts.filter(
		(p): p is FilePartLike =>
			p.type === 'file' && typeof (p as Partial<FilePartLike>).url === 'string'
	);
}
