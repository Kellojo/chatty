import { describe, expect, it } from 'vitest';
import { reuseUnchanged } from './chat-history.js';

type Message = { id: string; role: string; parts: { type: string; text: string }[] };

const msg = (id: string, text: string): Message => ({
	id,
	role: 'assistant',
	parts: [{ type: 'text', text }]
});

// The chat keeps its messages in deep `$state`, so `reuseUnchanged` sees
// proxies. Its cache relies on a kept message keeping its proxy.
describe('reuseUnchanged with $state messages', () => {
	it('keeps the proxies of unchanged messages through a reload', () => {
		const state = $state({ messages: [msg('a', 'one'), msg('b', 'two')] });
		const [a, b] = state.messages;
		expect(state.messages[0]).toBe(a);

		state.messages = reuseUnchanged(state.messages, [msg('a', 'one'), msg('b', 'two, longer')]);
		expect(state.messages[0]).toBe(a);
		expect(state.messages[1]).not.toBe(b);
		expect(state.messages[1].parts[0].text).toBe('two, longer');

		const changed = state.messages[1];
		state.messages = reuseUnchanged(state.messages, [msg('a', 'one'), msg('b', 'two')]);
		expect(state.messages[1]).not.toBe(changed);
		expect(state.messages[1].parts[0].text).toBe('two');
	});

	it('gives a replaced message a new proxy', () => {
		const state = $state({ messages: [msg('a', 'one')] });
		const before = state.messages[0];
		state.messages[0] = msg('a', 'one, streamed');
		expect(state.messages[0]).not.toBe(before);
		expect(reuseUnchanged(state.messages, [msg('a', 'one, streamed')])[0]).toBe(state.messages[0]);
	});
});
