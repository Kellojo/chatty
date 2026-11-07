import { afterEach, describe, expect, it } from 'vitest';
import { messageQueue } from './message-queue.svelte.js';

describe('messageQueue', () => {
	afterEach(() => {
		messageQueue.clear('c1');
		messageQueue.clear('c2');
	});

	it('keeps messages in order, per conversation', () => {
		const a = messageQueue.add('c1', { text: 'first' });
		messageQueue.add('c1', { text: 'second' });
		messageQueue.add('c2', { text: 'other' });
		expect(messageQueue.list('c1').map((m) => m.text)).toEqual(['first', 'second']);
		expect(messageQueue.list('c2').map((m) => m.text)).toEqual(['other']);

		expect(messageQueue.remove('c1', a.id)).toBe(a);
		expect(messageQueue.list('c1').map((m) => m.text)).toEqual(['second']);
		messageQueue.prepend('c1', a);
		expect(messageQueue.list('c1').map((m) => m.text)).toEqual(['first', 'second']);
	});

	it('ignores removing an unknown message', () => {
		messageQueue.add('c1', { text: 'first' });
		expect(messageQueue.remove('c1', 'nope')).toBeUndefined();
		expect(messageQueue.list('c1')).toHaveLength(1);
	});

	it('tracks whether a conversation queue is paused', () => {
		expect(messageQueue.isPaused('c1')).toBe(false);
		messageQueue.pause('c1');
		expect(messageQueue.isPaused('c1')).toBe(true);
		expect(messageQueue.isPaused('c2')).toBe(false);
		messageQueue.resume('c1');
		expect(messageQueue.isPaused('c1')).toBe(false);
	});
});
