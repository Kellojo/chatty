import { describe, expect, it } from 'vitest';
import {
	SHORTCUT_GROUPS,
	chatShortcuts,
	comboKeys,
	matchShortcut,
	modelPicker,
	registerChatShortcuts,
	registerModelPicker,
	shortcutLabel
} from './shortcuts.js';

type Mods = Partial<Record<'ctrl' | 'meta' | 'shift' | 'alt', boolean>>;

const key = (k: string, mods: Mods = {}) => ({
	key: k,
	ctrlKey: mods.ctrl ?? false,
	metaKey: mods.meta ?? false,
	shiftKey: mods.shift ?? false,
	altKey: mods.alt ?? false
});

describe('matchShortcut', () => {
	it('matches the modifier shortcuts with Ctrl, or Cmd on a Mac', () => {
		expect(matchShortcut(key('O', { ctrl: true, shift: true }), false, false)).toBe('new-chat');
		expect(matchShortcut(key('o', { meta: true, shift: true }), true, true)).toBe('new-chat');
		expect(matchShortcut(key('C', { ctrl: true, shift: true }), true, false)).toBe(
			'copy-last-reply'
		);
		expect(matchShortcut(key('c', { ctrl: true }), false, false)).toBeNull();
		expect(matchShortcut(key('o', { ctrl: true }), false, false)).toBeNull();
	});

	it('leaves Ctrl to text editing on a Mac and the Windows key to the OS', () => {
		expect(matchShortcut(key('b', { ctrl: true }), true, true)).toBeNull();
		expect(matchShortcut(key('k', { ctrl: true }), true, true)).toBeNull();
		expect(matchShortcut(key('b', { meta: true }), true, true)).toBe('toggle-sidebar');
		expect(matchShortcut(key('b', { meta: true }), false, false)).toBeNull();
		expect(matchShortcut(key('b', { ctrl: true, meta: true }), false, false)).toBeNull();
	});

	it('matches Escape and Shift+Escape', () => {
		expect(matchShortcut(key('Escape'), true)).toBe('escape');
		expect(matchShortcut(key('Escape', { shift: true }), true)).toBe('focus-composer');
	});

	it('only takes / when not typing', () => {
		expect(matchShortcut(key('/'), false)).toBe('focus-composer');
		expect(matchShortcut(key('/'), true)).toBeNull();
	});

	it('matches the Ctrl/Cmd navigation shortcuts, even while typing', () => {
		expect(matchShortcut(key('b', { ctrl: true }), true)).toBe('toggle-sidebar');
		expect(matchShortcut(key('K', { meta: true }), true, true)).toBe('search');
		expect(matchShortcut(key(',', { meta: true }), true, true)).toBe('open-settings');
		expect(matchShortcut(key('.', { ctrl: true }), true)).toBe('model-picker');
		expect(matchShortcut(key('/', { ctrl: true }), true)).toBe('show-shortcuts');
		// Layouts where "/" needs Shift.
		expect(matchShortcut(key('/', { ctrl: true, shift: true }), true)).toBe('show-shortcuts');
		expect(matchShortcut(key('?', { meta: true, shift: true }), true, true)).toBe('show-shortcuts');
		expect(matchShortcut(key('b', { ctrl: true, shift: true }), false)).toBeNull();
	});

	it('only takes ? for the shortcuts list when not typing', () => {
		expect(matchShortcut(key('?', { shift: true }), false)).toBe('show-shortcuts');
		expect(matchShortcut(key('?', { shift: true }), true)).toBeNull();
	});

	it('steps through conversations with Alt+Up and Alt+Down only', () => {
		expect(matchShortcut(key('ArrowUp', { alt: true }), true)).toBe('previous-chat');
		expect(matchShortcut(key('ArrowDown', { alt: true }), false)).toBe('next-chat');
		expect(matchShortcut(key('ArrowDown', { alt: true, shift: true }), false)).toBeNull();
		expect(matchShortcut(key('ArrowDown'), false)).toBeNull();
	});

	it('leaves ⌥↑/⌥↓ to text fields on a Mac, where they move the caret', () => {
		expect(matchShortcut(key('ArrowUp', { alt: true }), true, true)).toBeNull();
		expect(matchShortcut(key('ArrowUp', { alt: true }), false, true)).toBe('previous-chat');
		expect(matchShortcut(key('ArrowUp', { alt: true }), true, false)).toBe('previous-chat');
	});

	it('ignores other Alt combos and IME composition', () => {
		expect(matchShortcut(key('o', { ctrl: true, shift: true, alt: true }), false)).toBeNull();
		expect(matchShortcut(key('b', { ctrl: true, alt: true }), false)).toBeNull();
		expect(matchShortcut({ ...key('Escape'), isComposing: true }, false)).toBeNull();
	});
});

describe('labels', () => {
	it('spells out keys on Windows and Linux, and uses symbols on a Mac', () => {
		expect(shortcutLabel('new-chat', false)).toBe('Ctrl+Shift+O');
		expect(shortcutLabel('new-chat', true)).toBe('⌘⇧O');
		expect(comboKeys('Alt+↑', true)).toEqual(['⌥', '↑']);
		expect(comboKeys('Mod+,', false)).toEqual(['Ctrl', ',']);
	});

	it('documents every shortcut once', () => {
		const labels = SHORTCUT_GROUPS.flatMap((g) => g.entries.map((e) => e.label));
		expect(new Set(labels).size).toBe(labels.length);
		expect(SHORTCUT_GROUPS.every((g) => g.entries.every((e) => e.combos.length > 0))).toBe(true);
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

describe('registerModelPicker', () => {
	it('tracks the latest registered picker and unregisters only itself', () => {
		const a = () => true;
		const b = () => false;
		const offA = registerModelPicker(a);
		const offB = registerModelPicker(b);
		offB();
		expect(modelPicker()).toBe(a);
		const offC = registerModelPicker(b);
		offA();
		expect(modelPicker()).toBe(b);
		offC();
		expect(modelPicker()).toBeNull();
	});
});
