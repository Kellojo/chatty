import { describe, expect, it } from 'vitest';
import { DraftStore } from './drafts.js';

function memoryStorage() {
	const items = new Map<string, string>();
	return {
		items,
		getItem: (key: string) => items.get(key) ?? null,
		setItem: (key: string, value: string) => void items.set(key, value),
		removeItem: (key: string) => void items.delete(key)
	};
}

describe('DraftStore', () => {
	it('keeps a draft per conversation', () => {
		const store = new DraftStore(() => memoryStorage());
		store.set('a', 'hello');
		store.set('b', 'world');
		expect(store.get('a')).toBe('hello');
		expect(store.get('b')).toBe('world');
		expect(store.get('c')).toBe('');
	});

	it('mirrors drafts to storage and restores them', () => {
		const storage = memoryStorage();
		new DraftStore(() => storage).set('a', 'saved');
		expect(new DraftStore(() => storage).get('a')).toBe('saved');
	});

	it('removes empty drafts and clears storage when none are left', () => {
		const storage = memoryStorage();
		const store = new DraftStore(() => storage);
		store.set('a', 'text');
		store.set('a', '   ');
		expect(store.get('a')).toBe('');
		store.set('b', 'x');
		store.clear('b');
		expect(storage.items.size).toBe(0);
	});

	it('works without storage and survives storage errors', () => {
		const throwing = {
			getItem: () => {
				throw new Error('blocked');
			},
			setItem: () => {
				throw new Error('full');
			},
			removeItem: () => {
				throw new Error('blocked');
			}
		};
		const store = new DraftStore(() => throwing);
		store.set('a', 'still here');
		expect(store.get('a')).toBe('still here');
		const none = new DraftStore(() => undefined);
		none.set('a', 'memory only');
		expect(none.get('a')).toBe('memory only');
	});

	it('ignores corrupt stored data', () => {
		const storage = memoryStorage();
		storage.setItem('chatty:drafts', '{not json');
		expect(new DraftStore(() => storage).get('a')).toBe('');
	});

	it('drops the oldest drafts beyond the limit', () => {
		const store = new DraftStore(() => memoryStorage());
		for (let i = 0; i < 55; i++) store.set(`c${i}`, `draft ${i}`);
		expect(store.get('c0')).toBe('');
		expect(store.get('c54')).toBe('draft 54');
	});
});
