import { describe, expect, it } from 'vitest';
import { chatShortcuts, matchShortcut, registerChatShortcuts } from './shortcuts.js';

type Mods = Partial<Record<'ctrl' | 'meta' | 'shift' | 'alt', boolean>>;

const key = (k: string, mods: Mods = {}) => ({
	key: k,
	ctrlKey: mods.ctrl ?? false,
	metaKey: mods.meta ?? false,
	shiftKey: mods.shift ?? false,
	altKey: mods.alt ?? false
});

describe('matchShortcut', () => {
	it('matches the modifier shortcuts with Ctrl or Cmd', () => {
		expect(matchShortcut(key('O', { ctrl: true, shift: true }), false)).toBe('new-chat');
		expect(matchShortcut(key('o', { meta: true, shift: true }), true)).toBe('new-chat');
		expect(matchShortcut(key('C', { ctrl: true, shift: true }), true)).toBe('copy-last-reply');
		expect(matchShortcut(key('c', { ctrl: true }), false)).toBeNull();
		expect(matchShortcut(key('o', { ctrl: true }), false)).toBeNull();
	});

	it('matches Escape and Shift+Escape', () => {
		expect(matchShortcut(key('Escape'), true)).toBe('escape');
		expect(matchShortcut(key('Escape', { shift: true }), true)).toBe('focus-composer');
	});

	it('only takes / when not typing', () => {
		expect(matchShortcut(key('/'), false)).toBe('focus-composer');
		expect(matchShortcut(key('/'), true)).toBeNull();
	});

	it('ignores Alt combos and IME composition', () => {
		expect(matchShortcut(key('o', { ctrl: true, shift: true, alt: true }), false)).toBeNull();
		expect(matchShortcut({ ...key('Escape'), isComposing: true }, false)).toBeNull();
	});
});

describe('registerChatShortcuts', () => {
	it('tracks the latest registered chat and unregisters only itself', () => {
		const a = { escape: () => true, lastReply: () => 'a' };
		const b = { escape: () => false, lastReply: () => 'b' };
		const offA = registerChatShortcuts(a);
		const offB = registerChatShortcuts(b);
		offA();
		expect(chatShortcuts()).toBe(b);
		offB();
		expect(chatShortcuts()).toBeNull();
	});
});
