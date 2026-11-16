import { describe, expect, it } from 'vitest';
import type { MessageText } from '../../db/repo/messages.js';
import { decodeCursor, encodeCursor, readChatPage, type ChatPage } from './chat-pages.js';

function chat(texts: string[]) {
	const rows: MessageText[] = texts.map((t, i) => ({
		id: `m${i}`,
		role: i % 2 ? 'assistant' : 'user',
		content_text: t,
		created_at: i,
		status: 'complete'
	}));
	const byId = new Map(rows.map((r) => [r.id, r]));
	return {
		ids: rows.map((r) => r.id),
		load: (ids: string[]) => ids.map((id) => byId.get(id)!)
	};
}

function ok(page: ChatPage | { error: string }): ChatPage {
	if ('error' in page) throw new Error(page.error);
	return page;
}

/** Follows cursors in one direction and joins the text read, split pieces included. */
function readAll(texts: string[], from: 'start' | 'end', maxChars: number): string[] {
	const { ids, load } = chat(texts);
	const pages: ChatPage[] = [];
	let page = ok(readChatPage(ids, load, { from, maxChars }));
	for (;;) {
		pages.push(page);
		const next = from === 'start' ? page.newerCursor : page.olderCursor;
		if (!next) break;
		page = ok(readChatPage(ids, load, { from, cursor: decodeCursor(next), maxChars }));
	}
	if (from === 'end') pages.reverse();
	// Glue split pieces back together into whole messages.
	const out: string[] = [];
	for (const m of pages.flatMap((p) => p.messages)) {
		if (m.cut === 'start' || m.cut === 'both') out[out.length - 1] += m.text;
		else out.push(m.text);
	}
	return out;
}

describe('readChatPage', () => {
	it('round-trips cursors', () => {
		const cursor = { direction: 'backward' as const, messageId: 'abc', offset: 12 };
		expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
		expect(decodeCursor('not a cursor')).toBeNull();
	});

	it('returns a short chat in one page', () => {
		const { ids, load } = chat(['a', 'b']);
		const page = ok(readChatPage(ids, load, { from: 'end', maxChars: 2000 }));
		expect(page.messages.map((m) => m.text)).toEqual(['a', 'b']);
		expect(page.olderCursor).toBeUndefined();
		expect(page.newerCursor).toBeUndefined();
	});

	it('handles an empty chat', () => {
		const page = ok(readChatPage([], () => [], { from: 'start', maxChars: 2000 }));
		expect(page).toEqual({ totalMessages: 0, range: null, messages: [] });
	});

	it('splits a message longer than a page and marks the cut', () => {
		const long = 'x'.repeat(5000);
		const { ids, load } = chat(['hi', long]);
		const first = ok(readChatPage(ids, load, { from: 'start', maxChars: 2000 }));
		expect(first.messages[0].text).toBe('hi');
		expect(first.messages[1].cut).toBe('end');
		expect(first.newerCursor).toBeDefined();
		const last = ok(readChatPage(ids, load, { from: 'end', maxChars: 2000 }));
		expect(last.messages).toHaveLength(1);
		expect(last.messages[0].cut).toBe('start');
		expect(last.messages[0].text.length).toBeLessThanOrEqual(2000);
	});

	it.each(['start', 'end'] as const)('reads every character exactly once from the %s', (from) => {
		const texts = ['short', 'y'.repeat(4321), '', 'z'.repeat(1500), 'mid', 'w'.repeat(9000), 'end'];
		expect(readAll(texts, from, 2000)).toEqual(texts.filter((t) => t));
	});

	it('rejects a cursor from another version of the chat', () => {
		const { ids, load } = chat(['a']);
		const page = readChatPage(ids, load, {
			from: 'start',
			cursor: { direction: 'forward', messageId: 'gone', offset: 0 },
			maxChars: 2000
		});
		expect(page).toHaveProperty('error');
	});
});
