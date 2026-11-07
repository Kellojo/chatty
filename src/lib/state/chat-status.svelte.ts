import { SvelteMap } from 'svelte/reactivity';

/** Conversations with a reply streaming on the server, mapped to when it started (ms). */
export const serverActiveChats = new SvelteMap<string, number>();
