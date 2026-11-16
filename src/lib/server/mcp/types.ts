import type { Privacy, Trust } from '../privacy/policy.js';

export interface CallerContext {
	userId: string;
	role: string;
	workspaceDir: string | null;
	documentsDir: string;
	author?: string;
	conversationId?: string | null;
	agentRunId?: string | null;
	/** The user message this turn answers, when the call comes from a chat turn. */
	messageId?: string | null;
	/**
	 * The turn's privacy (taint), shared with the model loop. Without it, tools
	 * fall back to the conversation's and run's flags (see callerPrivacy).
	 */
	privacy?: Privacy;
	/**
	 * Whether this turn may be handed private items (every model it can reach
	 * is trusted). Missing means untrusted: the gateway, background callers.
	 */
	trust?: Trust;
}
