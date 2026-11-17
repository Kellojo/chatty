// App-wide keyboard shortcuts: the key matching (pure), the list the settings
// page and the shortcuts dialog render, and slots for the views that own an
// action (the open chat stops and copies replies, the model picker opens).
//
// Kept deliberately short: everything else is one Mod+K away in the command
// palette. Each shortcut here either can't wait for the palette (Esc, Mod+S) or
// is pressed so often that a dedicated key pays off.

export type ShortcutAction =
	| 'escape'
	| 'command-palette'
	| 'new-chat'
	| 'focus-composer'
	| 'toggle-sidebar'
	| 'previous-chat'
	| 'next-chat'
	| 'show-shortcuts'
	| 'model-picker';

export const isMac =
	typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.userAgent ?? '');

type KeyInput = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'> & {
	isComposing?: boolean;
};

/**
 * The shortcut a key press triggers, if any. `typing` is whether focus is in a
 * text field, where plain keys (`/`) belong to the field — and on a Mac so
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
	if (mod && event.shiftKey) return key === 'o' ? 'new-chat' : null;
	if (mod) {
		if (key === 'k') return 'command-palette';
		if (key === 'b') return 'toggle-sidebar';
		if (key === '.') return 'model-picker';
		return null;
	}
	if (event.key === 'Escape' && !event.shiftKey) return 'escape';
	if (typing || event.shiftKey) return null;
	if (event.key === '/') return 'focus-composer';
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
	'command-palette': 'Mod+K',
	'new-chat': 'Mod+Shift+O',
	'focus-composer': '/',
	'toggle-sidebar': 'Mod+B',
	'previous-chat': 'Alt+↑',
	'next-chat': 'Alt+↓',
	'show-shortcuts': 'Mod+/',
	'model-picker': 'Mod+.',
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
			{
				label: 'Command palette',
				description: 'Search chats, agents and skills, go anywhere, run any action.',
				combos: [COMBOS['command-palette']]
			},
			{ label: 'New chat', combos: [COMBOS['new-chat']] },
			{ label: 'Toggle sidebar', combos: [COMBOS['toggle-sidebar']] },
			{
				label: 'Previous / next conversation',
				description: 'In sidebar order, including search results.',
				combos: [COMBOS['previous-chat'], COMBOS['next-chat']],
				separator: '/'
			},
			{ label: 'Show keyboard shortcuts', combos: [COMBOS['show-shortcuts']] }
		]
	},
	{
		title: 'Conversation',
		description: 'In a chat or on the new-chat page.',
		entries: [
			{
				label: 'Stop the reply, cancel editing or end voice mode',
				combos: [COMBOS.escape]
			},
			{ label: 'Choose a model', combos: [COMBOS['model-picker']] }
		]
	},
	{
		title: 'Composer',
		description: 'Writing a message.',
		entries: [
			{
				label: 'Focus the composer',
				description: "When you're not typing elsewhere.",
				combos: [COMBOS['focus-composer']]
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
		title: 'Lists and editors',
		description: 'Command palette, sidebar search, agents, skills and memory.',
		entries: [
			{ label: 'Move through results', combos: ['↑', '↓'], separator: '/' },
			{ label: 'Open the selected result', combos: ['Enter'] },
			{
				label: 'Close the palette or clear the search',
				description: 'In an empty sidebar search, goes back to the chat.',
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
