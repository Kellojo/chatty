/**
 * The pages a conversation's tools returned, for the ```links widget. The model
 * cites sources by URL only; the widget fills each one in from the card the tool
 * returned (title, site, favicon) and drops URLs no tool ever returned, which the
 * model made up or misremembered.
 *
 * Tools hand their cards over in `structuredContent.sources`, which the chat keeps
 * but the model never sees. Older replies carried them in the text the model saw:
 * a "Source card: {…}" part (fetch) or "[1] {…}" result lines (web_search).
 */

/** A page's card, as `fetch` and `web_search` return it. */
export interface SourceCard {
	url: string;
	title?: string;
	site?: string;
	description?: string;
	favicon?: string;
	image?: string;
}

export interface SourceIndex {
	/** Cards by normalized URL (see sourceKey). */
	cards: ReadonlyMap<string, SourceCard>;
	/** Every URL that appeared in a tool result, normalized: those may be cited too. */
	seen: ReadonlySet<string>;
}

const rec = (v: unknown): Record<string, unknown> | null =>
	typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/**
 * A URL in the form two mentions of the same page share: https, no "www.", no
 * fragment, no trailing slash. Null for anything that isn't an http(s) URL.
 */
export function sourceKey(url: string): string | null {
	const s = url.trim();
	if (!URL.canParse(s)) return null;
	const u = new URL(s);
	if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
	const host = u.hostname.toLowerCase().replace(/^www\./, '');
	const path = u.pathname.replace(/\/+$/, '');
	return `https://${host}${u.port ? `:${u.port}` : ''}${path}${u.search}`;
}

function asCard(v: unknown): SourceCard | null {
	const r = rec(v);
	if (!r || typeof r.url !== 'string' || !sourceKey(r.url)) return null;
	const card: SourceCard = { url: r.url };
	for (const key of ['title', 'site', 'description', 'favicon', 'image'] as const) {
		if (typeof r[key] === 'string' && r[key]) card[key] = r[key] as string;
	}
	return card;
}

/** The cards in a legacy text result: a "Source card: {…}" part or "[n] {…}" lines. */
function legacyCards(text: string): SourceCard[] {
	const cards: SourceCard[] = [];
	const json = text.startsWith('Source card: ')
		? [text.slice('Source card: '.length)]
		: [...text.matchAll(/^\[\d+\] (\{.*\})(?: \(.*\))?$/gm)].map((m) => m[1]);
	for (const raw of json) {
		try {
			const card = asCard(JSON.parse(raw));
			if (card) cards.push(card);
		} catch {
			// Not a card.
		}
	}
	return cards;
}

const URL_IN_TEXT = /https?:\/\/[^\s"'<>()[\]{}\\`]+/g;

interface PartSources {
	cards: SourceCard[];
	urls: string[];
}

/** Parsed once per tool output: completed outputs keep their identity while a reply streams. */
const parsed = new WeakMap<object, PartSources>();

function outputSources(output: Record<string, unknown>): PartSources {
	const cached = parsed.get(output);
	if (cached) return cached;
	const cards: SourceCard[] = [];
	const urls: string[] = [];
	const structured = rec(output.structuredContent)?.sources;
	if (Array.isArray(structured)) {
		for (const item of structured) {
			const card = asCard(item);
			if (card) cards.push(card);
		}
	}
	const content = Array.isArray(output.content) ? output.content : [];
	for (const part of content) {
		const text = rec(part)?.text;
		if (typeof text !== 'string') continue;
		if (!Array.isArray(structured)) cards.push(...legacyCards(text));
		for (const m of text.matchAll(URL_IN_TEXT)) urls.push(m[0].replace(/[.,;:!?]+$/, ''));
	}
	const result = { cards, urls };
	parsed.set(output, result);
	return result;
}

/** Every source a conversation's tool results returned. */
export function indexSources(
	messages: ReadonlyArray<{ parts: ReadonlyArray<unknown> }>
): SourceIndex {
	const cards = new Map<string, SourceCard>();
	const seen = new Set<string>();
	for (const message of messages) {
		for (const part of message.parts) {
			const output = rec(rec(part)?.output);
			if (!output) continue;
			const sources = outputSources(output);
			for (const card of sources.cards) {
				const key = sourceKey(card.url)!;
				// The first card of a page wins; a later one only fills fields it lacks.
				cards.set(key, { ...card, ...cards.get(key) });
				seen.add(key);
			}
			for (const url of sources.urls) {
				const key = sourceKey(url);
				if (key) seen.add(key);
			}
		}
	}
	return { cards, seen };
}
