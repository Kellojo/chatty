import type { Attachment } from 'svelte/attachments';

/**
 * Pins an element's CSS animations to the document timeline's origin, so every
 * element running the same animation moves in lockstep however late it mounted
 * (e.g. spinners on several sidebar rows).
 */
export const syncAnimation: Attachment<Element> = (el) => {
	for (const animation of el.getAnimations()) animation.startTime = 0;
};
