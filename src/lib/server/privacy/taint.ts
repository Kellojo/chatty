/**
 * A turn's privacy while it runs: its trust (may its tools return private
 * items?) and its taint (does it hold private data?). Shared by the model loop
 * and every tool of the turn, so a tool that returns private data taints the
 * whole turn before its result goes back to the model.
 */
import type { Db } from '../db/index.js';
import { setConversationPrivate } from '../db/repo/conversations.js';
import { publishServerEvent } from '../events/bus.js';
import { createLogger } from '../logger.js';
import { isPrivateContext, type Privacy, type Trust } from './policy.js';

const log = createLogger('privacy');

export class TurnPrivacy implements Privacy {
	tainted: boolean;
	reason?: string;
	readonly conversationId: string | null;
	readonly agentRunId: string | null;

	constructor(
		private readonly db: Db,
		private readonly userId: string,
		init: {
			conversationId?: string | null;
			agentRunId?: string | null;
			trust: Trust;
			/** Starts tainted whatever the flags say (e.g. a subagent of a tainted parent). */
			tainted?: boolean;
			reason?: string;
		}
	) {
		this.conversationId = init.conversationId ?? null;
		this.agentRunId = init.agentRunId ?? null;
		this.trust = init.trust;
		this.tainted = false;
		this.tainted = init.tainted === true || isPrivateContext(db, this);
		if (this.tainted) this.reason = init.reason ?? 'private chat';
	}

	readonly trust: Trust;

	/**
	 * Called once when this turn makes its conversation private (not for chats
	 * that already were). The chat service writes it into the reply as a notice.
	 */
	onPromoted?: (reason: string) => void;

	/** Whether this turn's tools may return private items (and taint it). */
	get trusted(): boolean {
		return this.trust === 'trusted';
	}

	/**
	 * Called by a tool about to return private items. Taint is sticky: the
	 * conversation becomes private in the DB now, before the result reaches the
	 * model, so no later step, fallback or background job can carry it out.
	 */
	markTainted(reason: string): void {
		if (!this.trusted) {
			// Untrusted turns must never be handed private items; tools filter first.
			throw new Error('Private data was offered to a turn that may not see it');
		}
		const first = !this.tainted;
		this.tainted = true;
		this.reason ??= reason;
		if (!this.conversationId) return;
		const changed = setConversationPrivate(this.db, this.conversationId, true);
		if (changed) {
			log.info('Conversation became private', { conversationId: this.conversationId, reason });
			try {
				this.onPromoted?.(reason);
			} catch (e) {
				// The notice is a courtesy; the flag above is what protects the data.
				log.warn('Could not show the private notice', { error: String(e) });
			}
			publishServerEvent(this.userId, {
				type: 'conversation.privacy',
				conversationId: this.conversationId,
				private: true,
				reason
			});
		} else if (first) {
			log.info('Turn tainted', { conversationId: this.conversationId, reason });
		}
	}
}

/** Whether `privacy` can record taint (a turn's), or is a plain snapshot. */
export function isTurnPrivacy(privacy: Privacy | undefined): privacy is TurnPrivacy {
	return privacy instanceof TurnPrivacy;
}
