import type { UIMessage } from 'ai';

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
}

export type ModelRole = 'chat' | 'title' | 'memory' | 'research';

export type RoleDefaults = Partial<Record<ModelRole, string>>;

export interface ModelsByProvider {
	provider: Provider;
	models: ChatModel[];
}

export interface McpServerInfo {
	id: string;
	name: string;
	transport: 'builtin' | 'stdio' | 'http' | 'sse';
	url: string | null;
	hasToken: boolean;
	enabled: boolean;
	builtin: boolean;
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
	createdAt: number;
	updatedAt: number;
}

export const AGENT_EVENT_NAMES = [
	'memory.changed',
	'chat.created',
	'chat.message_completed',
	'skill.created',
	'skill.updated',
	'skill.deleted'
] as const;

export type AgentEventName = (typeof AGENT_EVENT_NAMES)[number];

export type ServerEvent =
	| { type: 'chat.created'; conversationId: string }
	| { type: 'chat.message_completed'; conversationId: string }
	| { type: 'chat.stream.started'; conversationId: string }
	| { type: 'chat.stream.finished'; conversationId: string }
	| { type: 'conversation.updated'; conversationId: string }
	| {
			type: 'memory.changed';
			scope: 'user' | 'shared';
			path: string;
			action: 'create' | 'update' | 'delete';
			author: string;
	  }
	| { type: 'agent.run.started'; agentId: string; runId: string }
	| { type: 'agent.run.progress'; agentId: string; runId: string }
	| { type: 'agent.run.finished'; agentId: string; runId: string; status: AgentRunStatus }
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
	enabled: boolean;
	lastRunAt: number | null;
	nextRunAt: number | null;
	createdAt: number;
	updatedAt: number;
}

export type AgentRunTrigger = 'schedule' | 'http' | 'manual' | 'chat' | 'event';

export type AgentRunStatus = 'running' | 'success' | 'failed';

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
}

export type ProxyRequestStatus = 'running' | 'complete' | 'failed';

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
	costUsd: number | null;
	stream: boolean;
	error: string | null;
	compression: ProxyCompression | null;
}

export interface MessageUsage {
	providerId: string;
	modelId: string;
	inputTokens: number | null;
	outputTokens: number | null;
	totalTokens: number | null;
	latencyMs: number | null;
	costUsd: number | null;
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
}

export function chatMessageToUIMessage(message: ChatMessage): UIMessage {
	return {
		id: message.id,
		role: message.role,
		parts: message.parts as UIMessage['parts'],
		metadata: message.usage ? { usage: message.usage } : undefined
	};
}
