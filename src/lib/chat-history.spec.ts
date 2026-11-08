import { describe, expect, it } from 'vitest';
import {
	messageFiles,
	messageText,
	prependOlder,
	reuseUnchanged,
	withLatestPage
} from './chat-history.js';

const m = (...ids: string[]) => ids.map((id) => ({ id }));
const ids = (list: { id: string }[]) => list.map((x) => x.id);

describe('prependOlder', () => {
	it('puts the older page in front', () => {
		expect(ids(prependOlder(m('c', 'd'), m('a', 'b')))).toEqual(['a', 'b', 'c', 'd']);
	});

	it('skips messages already shown', () => {
		expect(ids(prependOlder(m('b', 'c'), m('a', 'b')))).toEqual(['a', 'b', 'c']);
		const current = m('a');
		expect(prependOlder(current, m('a'))).toBe(current);
	});
});

describe('withLatestPage', () => {
	it('keeps earlier pages in front of an overlapping newest page', () => {
		const result = withLatestPage(m('a', 'b', 'c', 'd'), m('c', 'd', 'e'));
		expect(ids(result.messages)).toEqual(['a', 'b', 'c', 'd', 'e']);
		expect(result.keptOlder).toBe(true);
	});

	it('replaces everything when the newest page starts the list', () => {
		const result = withLatestPage(m('a', 'b'), m('a', 'x'));
		expect(ids(result.messages)).toEqual(['a', 'x']);
		expect(result.keptOlder).toBe(false);
	});

	it('replaces everything when the pages do not overlap', () => {
		const result = withLatestPage(m('a', 'b'), m('y', 'z'));
		expect(ids(result.messages)).toEqual(['y', 'z']);
		expect(result.keptOlder).toBe(false);
		expect(withLatestPage(m('a'), []).messages).toEqual([]);
	});
});

describe('message parts', () => {
	const message = {
		parts: [
			{ type: 'text', text: 'Hello ' },
			{ type: 'file', url: '/f/1', mediaType: 'image/png', filename: 'a.png' },
			{ type: 'reasoning', text: 'hidden' },
			{ type: 'text', text: 'world' }
		]
	};

	it('joins the text parts', () => {
		expect(messageText(message)).toBe('Hello world');
	});

	it('lists the file parts', () => {
		expect(messageFiles(message)).toEqual([
			{ type: 'file', url: '/f/1', mediaType: 'image/png', filename: 'a.png' }
		]);
	});
});

describe('reuseUnchanged', () => {
	const msg = (id: string, text: string, metadata?: unknown) => ({
		id,
		role: 'assistant',
		parts: [{ type: 'text', text }],
		metadata
	});

	it('keeps the objects of unchanged messages and takes changed and new ones', () => {
		const a = msg('a', 'one');
		const b = msg('b', 'two');
		const next = [msg('a', 'one'), msg('b', 'two, longer'), msg('c', 'three')];
		const merged = reuseUnchanged([a, b], next);
		expect(merged[0]).toBe(a);
		expect(merged[1]).toBe(next[1]);
		expect(merged[2]).toBe(next[2]);
	});

	it('treats changed metadata as a change', () => {
		const a = msg('a', 'one');
		const next = [msg('a', 'one', { status: 'failed' })];
		expect(reuseUnchanged([a], next)[0]).toBe(next[0]);
	});

	it('returns the current list itself when nothing changed', () => {
		const current = [msg('a', 'one'), msg('b', 'two')];
		expect(reuseUnchanged(current, [msg('a', 'one'), msg('b', 'two')])).toBe(current);
	});

	it('follows the new order and drops messages that are gone', () => {
		const a = msg('a', 'one');
		const b = msg('b', 'two');
		const merged = reuseUnchanged([a, b], [msg('b', 'two')]);
		expect(merged).toEqual([b]);
		expect(merged[0]).toBe(b);
	});
});
