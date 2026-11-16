/**
 * How the data tools (chat search, documents, agent runs) handle private
 * items. They never decide trust themselves: a turn may be handed private
 * items only when it is trusted and can record taint (a TurnPrivacy, see
 * privacy/taint.ts). Everything else (the MCP gateway, background callers)
 * is untrusted and must not learn that a private item exists.
 */
import { isTurnPrivacy } from '../../privacy/taint.js';
import type { CallerContext } from '../types.js';

/** Whether this caller may be handed private items (and is tainted by them). */
export function seesPrivate(ctx: CallerContext): boolean {
	return ctx.trust === 'trusted' && isTurnPrivacy(ctx.privacy) && ctx.privacy.trusted;
}

/**
 * Records that the tool is about to return private items: taints the turn and
 * marks its conversation private before the result goes back to the model.
 * Only call it after `seesPrivate(ctx)` allowed the items.
 */
export function reportPrivate(ctx: CallerContext, reason: string): void {
	if (!isTurnPrivacy(ctx.privacy)) {
		throw new Error('Private items were returned to a caller that cannot record taint');
	}
	ctx.privacy.markTainted(reason);
}

/** The note an untrusted caller gets instead of the private items it may not see. */
export function hiddenNote(count: number): string {
	return `${count} private result${count === 1 ? '' : 's'} hidden: this chat can reach a model that may not see private data`;
}
