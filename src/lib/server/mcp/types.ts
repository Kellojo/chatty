import type { Privacy } from '../privacy/policy.js';

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
}
