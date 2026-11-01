import { afterEach, describe, expect, it } from 'vitest';
import { pendingMessage } from './pending-message.svelte.js';

describe('pendingMessage', () => {
	afterEach(() => pendingMessage.clear());

	it('is delivered once to the conversation it was set for', () => {
		pendingMessage.set('c1', 'hello');
		expect(pendingMessage.consume('c1')).toEqual({ text: 'hello', files: [] });
		expect(pendingMessage.consume('c1')).toBeNull();
	});

	it('is not delivered to a different conversation', () => {
		pendingMessage.set('c1', 'hello');
		expect(pendingMessage.consume('c2')).toBeNull();
		expect(pendingMessage.consume('c1')).not.toBeNull();
	});
});
