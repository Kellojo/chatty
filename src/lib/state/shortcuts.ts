// App-wide keyboard shortcuts: the key matching (pure), the list the settings
// page and the shortcuts dialog render, and slots for the views that own an
// action (the open chat stops and copies replies, the model picker opens).

export type ShortcutAction =
	| 'escape'
	| 'new-chat'
	| 'focus-composer'
	| 'copy-last-reply'
	| 'toggle-sidebar'
	| 'previous-chat'
	| 'next-chat'
	| 'open-settings'
	| 'show-shortcuts'
	| 'model-picker'
	| 'search';

export const isMac =
	typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.userAgent ?? '');

type KeyInput = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'> & {
	isComposing?: boolean;
};

/**
 * The shortcut a key press triggers, if any. `typing` is whether focus is in a
 * text field, where plain keys (`/`, `?`) belong to the field — and on a Mac so
 * does ⌥↑/⌥↓, which moves the caret by paragraph.
 */
export function matchShortcut(
	event: KeyInput,
	typing: boolean,
	mac = isMac
): ShortcutAction | null {
	if (event.isComposing) return null;
	// ⌘ on a Mac (where Ctrl+B/K/… are text-editing keys), Ctrl elsewhere.
	const mod = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
	const key = event.key.toLowerCase();
	if (event.altKey) {
		if (mod || event.shiftKey || (typing && mac)) return null;
		if (event.key === 'ArrowUp') return 'previous-chat';
		if (event.key === 'ArrowDown') return 'next-chat';
		return null;
	}
	// Layouts that need Shift for "/" report "/" with Shift held; US reports "?".
	if (mod && (key === '/' || key === '?')) return 'show-shortcuts';
	if (mod && event.shiftKey) {
		if (key === 'o') return 'new-chat';
		if (key === 'c') return 'copy-last-reply';
		return null;
	}
	if (mod) {
		if (key === 'b') return 'toggle-sidebar';
		if (key === 'k') return 'search';
		if (key === ',') return 'open-settings';
		if (key === '.') return 'model-picker';
		return null;
	}
	if (event.key === 'Escape') return event.shiftKey ? 'focus-composer' : 'escape';
	if (typing) return null;
	if (event.key === '/') return 'focus-composer';
	if (event.key === '?') return 'show-shortcuts';
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

// ── the documented list ──────────────────────────────────────────────────

/**
 * One key combination, keys joined with "+". `Mod` is Ctrl, or ⌘ on a Mac;
 * a lone "+" is not a key here (no shortcut uses it).
 */
type Combo = string;

/** Key combinations by action, for tooltips and the documented list. */
export const COMBOS = {
	escape: 'Esc',
	'new-chat': 'Mod+Shift+O',
	'focus-composer': '/',
	'copy-last-reply': 'Mod+Shift+C',
	'toggle-sidebar': 'Mod+B',
	'previous-chat': 'Alt+↑',
	'next-chat': 'Alt+↓',
	'open-settings': 'Mod+,',
	'show-shortcuts': 'Mod+/',
	'model-picker': 'Mod+.',
	search: 'Mod+K',
	save: 'Mod+S'
} as const satisfies Record<ShortcutAction | 'save', Combo>;

const MAC_KEYS: Record<string, string> = { Mod: '⌘', Alt: '⌥', Shift: '⇧' };

/** The keys of a combination as shown on a keyboard, e.g. ["Ctrl", "Shift", "O"]. */
export function comboKeys(combo: Combo, mac = isMac): string[] {
	return combo
		.split('+')
		.map((key) => (mac ? (MAC_KEYS[key] ?? key) : key === 'Mod' ? 'Ctrl' : key));
}

/** Human-readable keys for tooltips, e.g. "Ctrl+Shift+O". */
export function shortcutLabel(action: keyof typeof COMBOS, mac = isMac): string {
	return comboKeys(COMBOS[action], mac).join(mac ? '' : '+');
}

export interface ShortcutEntry {
	label: string;
	description?: string;
	/** Alternatives, each a combination; `separator` goes between them. */
	combos: Combo[];
	separator?: 'or' | '/';
}

export interface ShortcutGroup {
	title: string;
	description: string;
	entries: ShortcutEntry[];
}

/** Every shortcut, as the settings page and the shortcuts dialog list them. */
export const SHORTCUT_GROUPS: ShortcutGroup[] = [
	{
		title: 'General',
		description: 'Work from anywhere in the app.',
		entries: [
			{ label: 'Search conversations', combos: [COMBOS.search] },
			{ label: 'New chat', combos: [COMBOS['new-chat']] },
			{ label: 'Toggle sidebar', combos: [COMBOS['toggle-sidebar']] },
			{
				label: 'Previous / next conversation',
				description: 'In sidebar order, including search results.',
				combos: [COMBOS['previous-chat'], COMBOS['next-chat']],
				separator: '/'
			},
			{ label: 'Open settings', combos: [COMBOS['open-settings']] },
			{
				label: 'Show keyboard shortcuts',
				description: "? works when you're not typing.",
				combos: [COMBOS['show-shortcuts'], '?'],
				separator: 'or'
			}
		]
	},
	{
		title: 'Conversation',
		description: 'In a chat or on the new-chat page.',
		entries: [
			{ label: 'Stop the reply or cancel editing', combos: [COMBOS.escape] },
			{ label: 'Copy the last reply', combos: [COMBOS['copy-last-reply']] },
			{ label: 'Choose a model', combos: [COMBOS['model-picker']] }
		]
	},
	{
		title: 'Composer',
		description: 'Writing a message.',
		entries: [
			{
				label: 'Focus the composer',
				combos: [COMBOS['focus-composer'], 'Shift+Esc'],
				separator: 'or'
			},
			{ label: 'Send', combos: ['Enter'] },
			{ label: 'New line', combos: ['Shift+Enter'] },
			{
				label: 'Edit your last message',
				description: 'In an empty composer; not in coding sessions.',
				combos: ['↑']
			}
		]
	},
	{
		title: 'Search and editors',
		description: 'Sidebar search, agents, skills and memory.',
		entries: [
			{ label: 'Move through results', combos: ['↑', '↓'], separator: '/' },
			{ label: 'Open the selected result', combos: ['Enter'] },
			{
				label: 'Clear the search',
				description: 'Press again to go back to the chat.',
				combos: ['Esc']
			},
			{
				label: 'Save',
				description: 'Agent, skill and memory editors.',
				combos: [COMBOS.save]
			}
		]
	}
];

// ── views that own an action ─────────────────────────────────────────────

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

/** Opens the chat's model picker; false when it can't open (disabled). */
type ModelPickerOpener = () => boolean;

// A stack, so a picker mounting before the previous one unmounts (page
// transitions) doesn't lose the slot when the old one unregisters.
const modelPickers: ModelPickerOpener[] = [];

/** Registers the model picker of the open chat or new-chat page; returns the unregister function. */
export function registerModelPicker(open: ModelPickerOpener): () => void {
	modelPickers.push(open);
	return () => {
		const index = modelPickers.lastIndexOf(open);
		if (index !== -1) modelPickers.splice(index, 1);
	};
}

/** The most recently mounted model picker still on the page. */
export function modelPicker(): ModelPickerOpener | null {
	return modelPickers.at(-1) ?? null;
}
