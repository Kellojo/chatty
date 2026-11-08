// T3 Code agents link to other threads as `t3-thread://v2/<environmentId>/<threadId>`,
// where the environment id is the T3 server's own id (`remote_environment_id`
// in Chatty). Chatty routes those links to the coding conversation of the
// thread instead, via `/t3-thread/<environmentId>/<threadId>`.

const ID = '[A-Za-z0-9_-]{1,200}';
const LINK_RE = new RegExp(`^t3-thread://v2/(${ID})/(${ID})/?$`, 'i');
const PATH_RE = new RegExp(`^/t3-thread/(${ID})/(${ID})$`);

export interface T3ThreadRef {
	environmentId: string;
	threadId: string;
}

/** Parses a `t3-thread://v2/<environmentId>/<threadId>` link. */
export function parseT3ThreadLink(url: string): T3ThreadRef | null {
	const m = LINK_RE.exec(url.trim());
	return m ? { environmentId: m[1], threadId: m[2] } : null;
}

/** Chatty's path that opens the thread a T3 thread link points to. */
export function t3ThreadPath(ref: T3ThreadRef): string {
	return `/t3-thread/${encodeURIComponent(ref.environmentId)}/${encodeURIComponent(ref.threadId)}`;
}

/** The Chatty path for a T3 thread link, or null when `url` isn't one. */
export function t3ThreadLinkToPath(url: string): string | null {
	const ref = parseT3ThreadLink(url);
	return ref ? t3ThreadPath(ref) : null;
}

/** Parses a path made by {@link t3ThreadPath}. */
export function parseT3ThreadPath(path: string): T3ThreadRef | null {
	const m = PATH_RE.exec(path);
	return m ? { environmentId: m[1], threadId: m[2] } : null;
}
