import type { UIMessage } from 'ai';
import type { AgentCodingTarget, CodingConversationSummary } from './coding-environments.js';

export type { UIMessage };

export interface Provider {
	id: string;
	name: string;
	type: 'anthropic' | 'openai-compatible';
	baseUrl: string | null;
	hasApiKey: boolean;
	enabled: boolean;
	createdAt: number;
}

export interface ChatModel {
	id: string;
	providerId: string;
	modelId: string;
	displayName: string;
	capabilities: string[];
	enabled: boolean;
	priceInput: number | null;
	priceOutput: number | null;
	priceCacheRead?: number | null;
	priceCacheWrite?: number | null;
}

export type ModelRole =
	'chat' | 'title' | 'memory' | 'image' | 'compaction' | 'speech-to-text' | 'decisions';

export type RoleDefaults = Partial<Record<ModelRole, string>>;

export interface ModelsByProvider {
	provider: Provider;
	models: ChatModel[];
}

export interface ToolInfo {
	name: string;
	description: string;
	server: string;
}

export interface McpServerInfo {
	id: string;
	name: string;
	transport: 'builtin' | 'stdio' | 'http' | 'sse';
	url: string | null;
	/** stdio only: executable and arguments spawned on the host. */
	command: string | null;
	args: string[];
	hasToken: boolean;
	enabled: boolean;
	builtin: boolean;
	/** 'deferred': the model loads these tools on demand via search_tools. */
	loadMode: 'always' | 'deferred';
}

export interface Conversation {
	id: string;
	kind: 'chat' | 'agent-run' | 'research';
	title: string;
	mode: 'chat' | 'agent';
	providerId: string | null;
	modelId: string | null;
	systemPrompt: string | null;
	memoryEnabled: boolean;
	maxSteps: number | null;
	temperature: number | null;
	maxTokens: number | null;
	pinned: boolean;
	agentId: string | null;
	/** 'dispatch': started by Chatty as an agent run the user can reply to. */
	origin: ConversationOrigin;
	/** The conversation's latest agent run, if an agent run created it. */
	agentRun: { id: string; status: AgentRunStatus } | null;
	settledAt: number | null;
	settledReason: 'manual' | 'auto' | null;
	/** Set when the conversation is a coding task run on a T3 Code server. */
	coding: CodingConversationSummary | null;
	createdAt: number;
	updatedAt: number;
}

export type ConversationOrigin = 'user' | 'dispatch';

export const AGENT_EVENT_NAMES = [
	'memory.changed',
	'chat.created',
	'chat.message_completed',
	'skill.created',
	'skill.updated',
	'skill.deleted',
	'coding.thread.finished'
] as const;

export type AgentEventName = (typeof AGENT_EVENT_NAMES)[number];

export type ServerEvent =
	| { type: 'chat.created'; conversationId: string }
	/** `agentRunId` is set when an agent run's turn produced the message (its run event notifies instead). */
	| { type: 'chat.message_completed'; conversationId: string; agentRunId?: string }
	| { type: 'chat.stream.started'; conversationId: string; startedAt?: number }
	| { type: 'chat.stream.finished'; conversationId: string }
	/** Persisted messages changed outside a live stream; an open chat should reload them. */
	| { type: 'chat.messages.updated'; conversationId: string }
	| { type: 'conversation.updated'; conversationId: string }
	/**
	 * The conversation's shown version changed: a branch was switched to or
	 * deleted, or an edit/regenerate started a new one. An open chat should
	 * reload its active path (e.g. GET /api/conversations/[id]/messages).
	 */
	| { type: 'conversation.branch_changed'; conversationId: string }
	| { type: 'conversation.compacted'; conversationId: string }
	| { type: 'conversation.settle_changed'; conversationIds: string[]; settled: boolean }
	/** The conversation was moved to trash; lists should drop it. */
	| { type: 'conversation.deleted'; conversationId: string }
	/** A coding task's status, pending approval, branch or PR changed. */
	| { type: 'coding.task.updated'; conversationId: string }
	/** A coding task's agent run ended (completed, failed or interrupted). */
	| {
			type: 'coding.thread.finished';
			conversationId: string;
			status: 'completed' | 'failed' | 'interrupted';
			branch: string | null;
			prUrl: string | null;
	  }
	| {
			type: 'memory.changed';
			scope: 'user' | 'shared';
			path: string;
			action: 'create' | 'update' | 'delete';
			author: string;
			/** Set when an agent run made the change (lets that agent ignore its own writes). */
			agentRunId?: string;
	  }
	| { type: 'agent.run.started'; agentId: string; runId: string; conversationId?: string }
	| { type: 'agent.run.progress'; agentId: string; runId: string }
	/** The run ended its turn with a question (`ask_user`) and waits for the user's reply. */
	| {
			type: 'agent.run.awaiting_input';
			agentId: string;
			runId: string;
			conversationId: string;
			question: string;
	  }
	| {
			type: 'agent.run.finished';
			agentId: string;
			runId: string;
			status: AgentRunStatus;
			/** The run's conversation, and whether it is a visible (dispatched) chat. */
			conversationId?: string;
			visible?: boolean;
	  }
	| { type: 'skills.changed' }
	| { type: 'skill.created'; name: string; scope: 'user' | 'shared' }
	| { type: 'skill.updated'; name: string; scope: 'user' | 'shared' }
	| { type: 'skill.deleted'; name: string; scope: 'user' | 'shared' }
	| { type: 'proxy.request.started'; requestId: string }
	| { type: 'proxy.request.finished'; requestId: string; status: 'complete' | 'failed' };

export type AgentTriggerType = 'persona' | 'schedule' | 'http' | 'manual' | 'event';

export interface AgentTriggerConfig {
	cron?: string;
	instructions?: string;
	event?: AgentEventName;
	every?: number;
}

export interface Agent {
	id: string;
	userId: string | null;
	name: string;
	description: string;
	systemPrompt: string;
	providerId: string | null;
	modelId: string | null;
	skillNames: string[];
	toolAllowlist: string[] | null;
	triggerType: AgentTriggerType;
	triggerConfig: AgentTriggerConfig;
	maxSteps: number | null;
	/** Whether runs may ask the user questions; anything but 'never' makes runs visible chats. */
	canAsk: AgentCanAsk;
	/** Set for coding agents: each run is a T3 coding task with this target. */
	codingTarget: AgentCodingTarget | null;
	enabled: boolean;
	lastRunAt: number | null;
	nextRunAt: number | null;
	createdAt: number;
	updatedAt: number;
}

export type AgentRunTrigger = 'schedule' | 'http' | 'manual' | 'chat' | 'event';

export const AGENT_CAN_ASK_VALUES = ['never', 'approvals', 'any'] as const;
export type AgentCanAsk = (typeof AGENT_CAN_ASK_VALUES)[number];

/**
 * `awaiting_input`: the run asked the user a question and waits for a reply.
 * `dismissed`: that question was left unanswered (settled, deleted, stopped or expired).
 */
export type AgentRunStatus = 'running' | 'success' | 'failed' | 'awaiting_input' | 'dismissed';

export interface AgentRun {
	id: string;
	agentId: string;
	userId: string;
	trigger: AgentRunTrigger;
	status: AgentRunStatus;
	conversationId: string | null;
	error: string | null;
	startedAt: number;
	endedAt: number | null;
}

/** What started a dispatched chat (an agent run), for its "Started by" chip. */
export interface DispatchInfo {
	runId: string;
	agentId: string;
	/** Null once the agent was deleted (its runs go with it). */
	agentName: string | null;
	trigger: AgentRunTrigger | null;
	startedAt: number | null;
	status: AgentRunStatus | null;
}

export interface ApiKey {
	id: string;
	label: string;
	scopes: string[];
	createdAt: number;
	lastUsedAt: number | null;
}

export interface ModelMappingTarget {
	providerId: string;
	modelId: string;
}

export interface ModelMapping {
	id: string;
	name: string;
	targets: ModelMappingTarget[];
	enabled: boolean;
	createdAt: number;
	capabilities?: string[];
}

export type ProxyRequestStatus = 'running' | 'complete' | 'failed';

export type RequestSource = 'proxy' | 'chat' | 'agent';

export type RequestPurpose = 'completion' | 'title' | 'compaction';

export interface ProxyCompression {
	caveman?: {
		level: string;
		estSaved: number | null;
		overhead?: number;
		basis?: 'baseline' | 'ratio';
	} | null;
}

export interface ProxyRequest {
	id: string;
	userId: string;
	apiKeyId: string | null;
	endpoint: string;
	requestedModel: string;
	mappingId: string | null;
	providerId: string | null;
	modelId: string | null;
	fallbackIndex: number;
	status: ProxyRequestStatus;
	httpStatus: number | null;
	startedAt: number;
	latencyMs: number | null;
	inputTokens: number | null;
	outputTokens: number | null;
	cacheReadTokens: number | null;
	cacheWriteTokens: number | null;
	costUsd: number | null;
	stream: boolean;
	error: string | null;
	compression: ProxyCompression | null;
	source: RequestSource;
	conversationId: string | null;
	runId: string | null;
	messageId: string | null;
	stepIndex: number;
	purpose: RequestPurpose;
}

/**
 * Rough character sizes of the prompt contributors, captured at generation
 * time. Only used to show each one's relative share of the input (percentages
 * in the UI) — not token counts and not for billing.
 */
export interface PromptCharBreakdown {
	/** Conversation prompt + global instructions. */
	system: number;
	/** Bound skill bodies + the available-skills index. */
	skills: number;
	/** Serialized tool definitions (MCP + builtin). */
	tools: number;
	/** Conversation history (messages, tool results, attachments). */
	messages: number;
}

export interface MessageUsage {
	providerId: string;
	modelId: string;
	inputTokens: number | null;
	outputTokens: number | null;
	totalTokens: number | null;
	latencyMs: number | null;
	costUsd: number | null;
	/** Present on newer messages; absent on pre-breakdown rows. */
	promptChars?: PromptCharBreakdown;
}

export interface ChatMessage {
	id: string;
	conversationId: string;
	role: 'user' | 'assistant' | 'system';
	parts: unknown[];
	status: 'complete' | 'partial' | 'failed';
	error: string | null;
	usage: MessageUsage | null;
	createdAt: number;
	/** Set when the message has alternative versions (edits or regenerated replies). */
	branch?: MessageBranch;
}

/** A message's place among its alternative versions, oldest first. */
export interface MessageBranch {
	index: number;
	count: number;
	ids: string[];
}

/** Client-side message metadata: usage for the info dialog, status for failed or stopped replies. */
export interface UIMessageMetadata {
	usage?: MessageUsage;
	status?: 'partial' | 'failed';
	error?: string | null;
	branch?: MessageBranch;
}

export function chatMessageToUIMessage(message: ChatMessage): UIMessage {
	const metadata: UIMessageMetadata = {};
	if (message.usage) metadata.usage = message.usage;
	if (message.branch) metadata.branch = message.branch;
	if (message.status !== 'complete') {
		metadata.status = message.status;
		metadata.error = message.error;
	}
	return {
		id: message.id,
		role: message.role,
		parts: message.parts as UIMessage['parts'],
		metadata: Object.keys(metadata).length > 0 ? metadata : undefined
	};
}
