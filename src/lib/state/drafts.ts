// Unsent composer text per conversation, so switching chats doesn't lose it.
// Kept in memory and mirrored to sessionStorage (survives reloads in this tab).

const STORAGE_KEY = 'chatty:drafts';
/** Oldest drafts are dropped beyond this, so the stored map can't grow unbounded. */
const MAX_DRAFTS = 50;

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export class DraftStore {
	#drafts: Map<string, string> | null = null;
	readonly #storage: () => StorageLike | undefined;

	constructor(storage: () => StorageLike | undefined) {
		this.#storage = storage;
	}

	get(conversationId: string): string {
		return this.#load().get(conversationId) ?? '';
	}

	/** Stores the draft; empty (or whitespace-only) text removes it. */
	set(conversationId: string, text: string): void {
		const drafts = this.#load();
		const had = drafts.has(conversationId);
		if (!text.trim()) {
			if (!had) return;
			drafts.delete(conversationId);
		} else {
			if (drafts.get(conversationId) === text) return;
			// Re-insert so the map stays ordered by last edit.
			drafts.delete(conversationId);
			drafts.set(conversationId, text);
			while (drafts.size > MAX_DRAFTS) drafts.delete(drafts.keys().next().value!);
		}
		this.#save(drafts);
	}

	clear(conversationId: string): void {
		this.set(conversationId, '');
	}

	#load(): Map<string, string> {
		if (this.#drafts) return this.#drafts;
		const drafts = new Map<string, string>();
		try {
			const raw = this.#storage()?.getItem(STORAGE_KEY);
			const parsed: unknown = raw ? JSON.parse(raw) : null;
			if (parsed && typeof parsed === 'object') {
				for (const [id, text] of Object.entries(parsed)) {
					if (typeof text === 'string' && text) drafts.set(id, text);
				}
			}
		} catch {
			// Unavailable or corrupt storage: start empty.
		}
		this.#drafts = drafts;
		return drafts;
	}

	#save(drafts: Map<string, string>): void {
		try {
			const storage = this.#storage();
			if (!storage) return;
			if (drafts.size === 0) storage.removeItem(STORAGE_KEY);
			else storage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(drafts)));
		} catch {
			// Storage full or blocked: the in-memory copy still works for this session.
		}
	}
}

export const drafts = new DraftStore(() =>
	typeof sessionStorage === 'undefined' ? undefined : sessionStorage
);
