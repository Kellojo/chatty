// App-wide keyboard shortcuts: the key matching (pure) and a slot for the chat
// view that is currently open, which owns stopping and copying replies.

export type ShortcutAction = 'escape' | 'new-chat' | 'focus-composer' | 'copy-last-reply';

type KeyInput = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'> & {
	isComposing?: boolean;
};

/**
 * The shortcut a key press triggers, if any. `typing` is whether focus is in a
 * text field, where plain keys (`/`) belong to the field.
 */
export function matchShortcut(event: KeyInput, typing: boolean): ShortcutAction | null {
	if (event.isComposing || event.altKey) return null;
	const mod = event.ctrlKey || event.metaKey;
	const key = event.key.toLowerCase();
	if (mod && event.shiftKey) {
		if (key === 'o') return 'new-chat';
		if (key === 'c') return 'copy-last-reply';
		return null;
	}
	if (mod) return null;
	if (event.key === 'Escape') return event.shiftKey ? 'focus-composer' : 'escape';
	if (event.key === '/' && !typing) return 'focus-composer';
	return null;
}

const NON_TEXT_INPUTS = new Set([
	'button',
	'checkbox',
	'radio',
	'submit',
	'reset',
	'range',
	'color',
	'file'
]);

/** Whether key presses on this element are text input. */
export function isTypingTarget(target: EventTarget | null): boolean {
	if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
	if (target.isContentEditable) return true;
	if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
	if (target instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(target.type);
	return false;
}

const isMac =
	typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.userAgent ?? '');

/** Human-readable keys for tooltips. */
export function shortcutLabel(action: ShortcutAction | 'search'): string {
	const mod = isMac ? '⌘' : 'Ctrl';
	switch (action) {
		case 'escape':
			return 'Esc';
		case 'new-chat':
			return `${mod}+Shift+O`;
		case 'copy-last-reply':
			return `${mod}+Shift+C`;
		case 'focus-composer':
			return '/';
		case 'search':
			return `${mod}+K`;
	}
}

/** What the open chat view offers to the global shortcuts. */
export interface ChatShortcutHandler {
	/** Stops a streaming reply or cancels an edit; false when there was nothing to do. */
	escape(): boolean;
	/** The latest assistant reply's text, or null when there is none. */
	lastReply(): string | null;
}

let activeChat: ChatShortcutHandler | null = null;

/** Registers the open chat view; returns the unregister function. */
export function registerChatShortcuts(handler: ChatShortcutHandler): () => void {
	activeChat = handler;
	return () => {
		if (activeChat === handler) activeChat = null;
	};
}

export function chatShortcuts(): ChatShortcutHandler | null {
	return activeChat;
}
