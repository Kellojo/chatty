import { getContext, setContext } from 'svelte';

/**
 * Whether the content being rendered belongs to a private chat, for widgets
 * that would otherwise reach out to third parties (map tiles). Set by the chat
 * view; anything rendered outside one reads false.
 */
export const PRIVATE_CHAT_KEY = Symbol('private-chat');

/** Call during the chat view's init; `get` is read whenever a widget checks (it may change). */
export function setPrivateChat(get: () => boolean): void {
	setContext(PRIVATE_CHAT_KEY, get);
}

/** A getter for whether this is a private chat (false outside a chat view). Call during init. */
export function getPrivateChat(): () => boolean {
	return getContext<(() => boolean) | undefined>(PRIVATE_CHAT_KEY) ?? (() => false);
}
