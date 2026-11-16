import { getContext, setContext } from 'svelte';
import type { CodingEnvironment } from '$lib/coding-environments.js';
import type { Agent } from '$lib/types.js';

/**
 * What the chat view tells the cards inside its messages: which chat they are
 * in (subagent rows look their subagent up by it) and where a coding task
 * proposed in it can be started.
 */
export interface ChatViewContext {
	conversationId: string;
	codingEnvironments: CodingEnvironment[];
	/** The user's own coding agents. */
	codingAgents: Agent[];
}

const KEY = Symbol('chat-view');

export function setChatViewContext(get: () => ChatViewContext): void {
	setContext(KEY, get);
}

/** Undefined outside a chat view (agent run and subagent transcripts, previews). */
export function getChatViewContext(): (() => ChatViewContext) | undefined {
	return getContext<(() => ChatViewContext) | undefined>(KEY);
}
