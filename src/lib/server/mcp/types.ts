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
}
