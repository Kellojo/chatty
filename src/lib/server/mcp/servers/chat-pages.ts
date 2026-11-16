import type { MessageText } from '../../db/repo/messages.js';

/**
 * Pages a chat's text by size instead of message count, so one `read_chat`
 * call never floods a small model's context: a page holds about `maxChars`
 * characters and a message too long for it is split across pages.
 *
 * A position is a point in the chat's text: before character `offset` of
 * message `index` (on the active path). A forward page starts at a position, a
 * backward page ends at one. Cursors carry a position plus the direction to
 * read in, keyed by message id so they survive new messages being added.
 */

export const READ_CHAT_DEFAULT_CHARS = 20_000;
export const READ_CHAT_MIN_CHARS = 2_000;
export const READ_CHAT_MAX_CHARS = 100_000;
/** Budgeted per message for its JSON fields. */
const MESSAGE_OVERHEAD = 100;
/** Don't start a split piece smaller than this; end the page instead. */
const MIN_SPLIT_CHARS = 500;
const LOAD_BATCH = 20;

export interface ChatCursor {
	direction: 'forward' | 'backward';
	messageId: string;
	offset: number;
}

export function encodeCursor(cursor: ChatCursor): string {
	return Buffer.from(
		JSON.stringify({
			d: cursor.direction === 'forward' ? 'f' : 'b',
			i: cursor.messageId,
			o: cursor.offset
		})
	).toString('base64url');
}

export function decodeCursor(value: string): ChatCursor | null {
	try {
		const raw = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
			d?: unknown;
			i?: unknown;
			o?: unknown;
		};
		if ((raw.d !== 'f' && raw.d !== 'b') || typeof raw.i !== 'string') return null;
		if (typeof raw.o !== 'number' || !Number.isInteger(raw.o) || raw.o < 0) return null;
		return { direction: raw.d === 'f' ? 'forward' : 'backward', messageId: raw.i, offset: raw.o };
	} catch {
		return null;
	}
}

export interface PageMessage {
	role: string;
	text: string;
	createdAt: number;
	status: string;
	/** Where text of this message was left out: it continues on another page. */
	cut?: 'start' | 'end' | 'both';
}

export interface ChatPage {
	totalMessages: number;
	/** 1-based numbers of the first and last message shown. */
	range: [number, number] | null;
	messages: PageMessage[];
	/** Reads the text before this page. */
	olderCursor?: string;
	/** Reads the text after this page. */
	newerCursor?: string;
}

interface Position {
	index: number;
	offset: number;
}

function cutOf(start: boolean, end: boolean): PageMessage['cut'] {
	return start && end ? 'both' : start ? 'start' : end ? 'end' : undefined;
}

export function readChatPage(
	ids: string[],
	load: (ids: string[]) => MessageText[],
	options: { from: 'start' | 'end'; cursor?: ChatCursor | null; maxChars: number }
): ChatPage | { error: string } {
	const n = ids.length;
	const cache = new Map<number, MessageText>();
	const get = (index: number, direction: 'forward' | 'backward'): MessageText => {
		let hit = cache.get(index);
		if (!hit) {
			const from = direction === 'forward' ? index : Math.max(0, index - LOAD_BATCH + 1);
			const to = direction === 'forward' ? Math.min(n, index + LOAD_BATCH) : index + 1;
			const rows = load(ids.slice(from, to));
			const byId = new Map(rows.map((r) => [r.id, r]));
			for (let i = from; i < to; i++) {
				cache.set(
					i,
					byId.get(ids[i]) ?? {
						id: ids[i],
						role: 'unknown',
						content_text: '',
						created_at: 0,
						status: 'complete'
					}
				);
			}
			hit = cache.get(index)!;
		}
		return hit;
	};
	const lengthOf = (index: number, direction: 'forward' | 'backward') =>
		(get(index, direction).content_text ?? '').length;
	const toMessage = (row: MessageText, text: string, cut: PageMessage['cut']): PageMessage => ({
		role: row.role,
		text,
		createdAt: row.created_at,
		status: row.status,
		...(cut ? { cut } : {})
	});

	let direction: 'forward' | 'backward' = options.from === 'start' ? 'forward' : 'backward';
	let anchor: Position =
		options.from === 'start' ? { index: 0, offset: 0 } : { index: n, offset: 0 };
	if (options.cursor) {
		const index = ids.indexOf(options.cursor.messageId);
		if (index === -1) {
			return {
				error: 'cursor no longer matches this chat (it was edited); read it again without a cursor'
			};
		}
		direction = options.cursor.direction;
		const length = lengthOf(index, direction);
		anchor = { index, offset: Math.min(options.cursor.offset, length) };
		if (direction === 'forward' && anchor.offset > 0 && anchor.offset >= length) {
			anchor = { index: index + 1, offset: 0 };
		}
	}

	const budget = options.maxChars;
	const messages: PageMessage[] = [];
	let used = 0;
	let first = -1;
	let last = -1;
	let start: Position;
	let end: Position;

	const take = (index: number, text: string, cut: PageMessage['cut'], atFront: boolean) => {
		used += text.length + MESSAGE_OVERHEAD;
		if (first === -1 || index < first) first = index;
		if (last === -1 || index > last) last = index;
		if (!text.trim() && !cut) return; // tool-only turns carry no text
		const message = toMessage(get(index, direction), text, cut);
		if (atFront) messages.unshift(message);
		else messages.push(message);
	};

	if (direction === 'forward') {
		start = anchor;
		let { index, offset } = anchor;
		while (index < n) {
			const text = get(index, 'forward').content_text ?? '';
			const rest = text.length - offset;
			const room = budget - used - MESSAGE_OVERHEAD;
			if (rest <= room) {
				take(index, text.slice(offset), cutOf(offset > 0, false), false);
				index++;
				offset = 0;
				continue;
			}
			if (used === 0 || room >= MIN_SPLIT_CHARS) {
				const size = Math.max(room, 1);
				take(index, text.slice(offset, offset + size), cutOf(offset > 0, true), false);
				offset += size;
			}
			break;
		}
		end = { index, offset };
	} else {
		end = anchor;
		let index = anchor.index;
		let stop = anchor.offset; // chars of message `index` that lie before the anchor
		if (stop === 0) {
			index--;
			stop = index >= 0 ? lengthOf(index, 'backward') : 0;
		}
		while (index >= 0) {
			const text = get(index, 'backward').content_text ?? '';
			const room = budget - used - MESSAGE_OVERHEAD;
			if (stop <= room) {
				take(index, text.slice(0, stop), cutOf(false, stop < text.length), true);
				index--;
				stop = index >= 0 ? lengthOf(index, 'backward') : 0;
				continue;
			}
			if (used === 0 || room >= MIN_SPLIT_CHARS) {
				const size = Math.max(room, 1);
				take(index, text.slice(stop - size, stop), cutOf(true, stop < text.length), true);
				stop -= size;
			}
			break;
		}
		// The page starts at `stop` of `index`; all of `index` left out means it starts after it.
		start =
			index < 0
				? { index: 0, offset: 0 }
				: stop >= lengthOf(index, 'backward')
					? { index: index + 1, offset: 0 }
					: { index, offset: stop };
	}
	const page: ChatPage = {
		totalMessages: n,
		range: first === -1 ? null : [first + 1, last + 1],
		messages
	};
	if (start.index > 0 || start.offset > 0) {
		// Backward from the start of message i is the same as from the end of i-1.
		const at = start.index < n ? start : { index: n - 1, offset: lengthOf(n - 1, direction) };
		page.olderCursor = encodeCursor({
			direction: 'backward',
			messageId: ids[at.index],
			offset: at.offset
		});
	}
	if (end.index < n) {
		page.newerCursor = encodeCursor({
			direction: 'forward',
			messageId: ids[end.index],
			offset: end.offset
		});
	}
	return page;
}
