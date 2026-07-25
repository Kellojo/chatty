import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
	convertToModelMessages,
	createUIMessageStream,
	createUIMessageStreamResponse,
	stepCountIs,
	streamText,
	type UIMessage,
	type UIMessageChunk
} from 'ai';
import { config } from '../config.js';
import { getDb, type Db } from '../db/index.js';
import {
	getConversation,
	setConversationTitle,
	touchConversation,
	updateConversation,
	type ConversationRow
} from '../db/repo/conversations.js';
import {
	createMessage,
	deleteMessagesNotIn,
	extractText,
	getMessage,
	updateMessage,
	type MessageUsage
} from '../db/repo/messages.js';
import { getAttachment, linkAttachmentsToMessage } from '../db/repo/attachments.js';
import { getAgent } from '../db/repo/agents.js';
import { findModel, findRoleModel } from '../db/repo/models.js';
import { getProvider } from '../db/repo/providers.js';
import { computeCostUsd } from '../proxy/pricing.js';
import { getGlobalInstructions } from '../db/repo/user-settings.js';
import { publishServerEvent } from '../events/bus.js';
import { createLogger } from '../logger.js';
import { recordSkillInvocation } from '../db/repo/skill-invocations.js';
import { resolveModel, ModelUnavailableError } from '../llm/registry.js';
import { isRetryableModelError, resolveRefTargets } from '../llm/mapped.js';
import { buildSystemPrompt } from '../llm/systemPrompt.js';
import { resolveSkill } from '../skills/scanner.js';
import { buildTools } from '../tools/registry.js';
import { conversationWorkspace, resolveAttachment } from '../workspaces.js';
import { attachmentCache } from './attachmentCache.js';
import { registerStream, releaseStream } from './streams.js';
import { generateConversationTitle } from './title.js';

const log = createLogger('chat');

export class ChatRequestError extends Error {
	constructor(
		public status: number,
		message: string
	) {
		super(message);
	}
}

const ATTACHMENT_URL_PREFIX = '/api/conversations/';

function attachmentIdFromUrl(url: string, conversationId: string): string | null {
	const prefix = `${ATTACHMENT_URL_PREFIX}${conversationId}/attachments/`;
	if (!url.startsWith(prefix)) return null;
	const id = url.slice(prefix.length).split(/[?#]/)[0];
	return id || null;
}

async function inlineAttachmentParts(db: Db, conversationId: string, messages: UIMessage[]): Promise<UIMessage[]> {
	return await Promise.all(messages.map(async (message) => ({
		...message,
		parts: await Promise.all(message.parts.map(async (part) => {
			if (part.type !== 'file') return part;
			const attachmentId = attachmentIdFromUrl(part.url, conversationId);
			if (!attachmentId) return part;
			const row = getAttachment(db, attachmentId);
			if (!row) return part;
			try {
				let dataUri = attachmentCache.get(attachmentId);
				if (dataUri === undefined) {
					const bytes = await fs.readFile(resolveAttachment(row.path));
					dataUri = `data:${row.mime};base64,${bytes.toString('base64')}`;
					attachmentCache.set(attachmentId, dataUri);
				}
				return { ...part, url: dataUri };
			} catch {
				return part;
			}
		}))
	})));
}

function ensureModel(db: Db, userId: string, conversation: ConversationRow): ConversationRow {
	if (conversation.provider_id && conversation.model_id) return conversation;
	const roleDefault = findRoleModel(db, 'chat');
	if (!roleDefault) {
		throw new ChatRequestError(
			400,
			'No model selected for this conversation and no default chat model is configured'
		);
	}
	const updated = updateConversation(db, userId, conversation.id, {
		providerId: roleDefault.provider_id,
		modelId: roleDefault.model_id
	});
	return updated ?? conversation;
}

function syncMessages(db: Db, conversationId: string, incoming: UIMessage[]): UIMessage {
	deleteMessagesNotIn(
		db,
		conversationId,
		incoming.map((m) => m.id)
	);
	const last = incoming[incoming.length - 1];
	if (!last || last.role !== 'user') {
		throw new ChatRequestError(400, 'Last message must be a user message');
	}
	const existing = getMessage(db, last.id);
	if (existing) {
		updateMessage(db, last.id, { parts: last.parts, error: null, status: 'complete' });
	} else {
		createMessage(db, {
			id: last.id,
			conversationId,
			role: 'user',
			parts: last.parts,
			status: 'complete'
		});
	}
	const attachmentIds = last.parts
		.filter((p) => p.type === 'file')
		.map((p) => attachmentIdFromUrl((p as { url: string }).url, conversationId))
		.filter((id): id is string => id !== null);
	linkAttachmentsToMessage(db, last.id, attachmentIds);
	return last;
}

export async function handleChatRequest(
	userId: string,
	body: { conversationId: string; messages: UIMessage[]; skill?: string }
): Promise<Response> {
	const db = getDb();
	let conversation = getConversation(db, userId, body.conversationId);
	if (!conversation) throw new ChatRequestError(404, 'Conversation not found');
	if (conversation.kind !== 'chat') throw new ChatRequestError(400, 'Not a chat conversation');

	conversation = ensureModel(db, userId, conversation);
	const agent = conversation.agent_id ? getAgent(db, conversation.agent_id) : undefined;
	const lastUserMessage = syncMessages(db, conversation.id, body.messages);
	if (conversation.title === '') {
		const raw = extractText(lastUserMessage.parts).trim().replace(/\s+/g, ' ');
		let provisional: string;
		if (raw.length <= 50) {
			provisional = raw;
		} else {
			const cut = raw.lastIndexOf(' ', 50);
			provisional = (cut > 10 ? raw.slice(0, cut) : raw.slice(0, 50)) + '\u2026';
		}
		setConversationTitle(db, conversation.id, provisional);
	}
	touchConversation(db, conversation.id);

	const ref = { providerId: conversation.provider_id!, modelId: conversation.model_id! };
	let targets;
	try {
		targets = resolveRefTargets(ref, db).targets;
	} catch (e) {
		if (e instanceof ModelUnavailableError) throw new ChatRequestError(400, e.message);
		throw e;
	}

	const available = targets.filter((t) => {
		const provider = getProvider(db, t.providerId);
		if (!provider || provider.enabled !== 1) return false;
		const model = findModel(db, t.providerId, t.modelId);
		return model !== undefined && model.enabled === 1;
	});
	if (available.length === 0) {
		const detail = targets
			.map((t) => {
				const provider = getProvider(db, t.providerId);
				if (!provider || provider.enabled !== 1) return `provider "${t.providerId}" is unavailable`;
				return `model "${t.modelId}" is disabled or unknown`;
			})
			.join('; ');
		throw new ChatRequestError(400, `The selected model is not available: ${detail}`);
	}
	targets = available;

	const { tools, close } = await buildTools({
		userId,
		memoryEnabled: conversation.memory_enabled === 1,
		workspaceDir: conversationWorkspace(conversation.id),
		agentAllowlist: agent?.tool_allowlist
			? (JSON.parse(agent.tool_allowlist) as string[])
			: undefined,
		conversationId: conversation.id
	});

	const controller = new AbortController();
	registerStream(conversation.id, controller);
	publishServerEvent(userId, { type: 'chat.stream.started', conversationId: conversation.id });

	let errorText: string | null = null;
	const agentSkillNames = agent ? (JSON.parse(agent.skill_names) as string[]) : [];
	const boundSkillNames = [...agentSkillNames];
	let manualSkillWarning: string | null = null;
	if (body.skill) {
		const skill = resolveSkill(userId, body.skill);
		if (!skill) {
			manualSkillWarning = `The requested skill "${body.skill}" was not found.`;
		} else if (!skill.enabled) {
			manualSkillWarning = `The requested skill "${body.skill}" is disabled.`;
		} else {
			boundSkillNames.push(skill.name);
			recordSkillInvocation(db, {
				skillName: skill.name,
				scope: skill.scope,
				userId,
				conversationId: conversation.id,
				messageId: lastUserMessage.id,
				triggeredBy: 'manual'
			});
		}
	}
	const system = buildSystemPrompt(conversation, {
		globalInstructions: getGlobalInstructions(db, userId),
		userId,
		boundSkillNames,
		includeSkillsIndex: 'load_skill' in tools,
		extraWarning: manualSkillWarning
	});
	const modelMessages = await convertToModelMessages(
		await inlineAttachmentParts(db, conversation.id, body.messages)
	);
	const stopWhen = stepCountIs(
		conversation.mode === 'agent' ? (conversation.max_steps ?? config.AGENT_MAX_STEPS) : 5
	);

	let usageMeta: MessageUsage | null = null;

	const stream = createUIMessageStream<UIMessage>({
		originalMessages: body.messages,
		generateId: () => randomUUID(),
		onError: (error) => {
			log.error('Chat stream error', {
				conversationId: conversation.id,
				error: error instanceof Error ? error.message : String(error)
			});
			return errorText ?? 'An error occurred while generating the response';
		},
		execute: async ({ writer }) => {
			let lastError: unknown = null;
			let totalTokensUsed: import('ai').LanguageModelUsage | undefined;
			for (let i = 0; i < targets.length; i++) {
				const target = targets[i];
				let contentful = false;
				const buffer: UIMessageChunk[] = [];
				try {
					const model = resolveModel(target);
					const startedAt = Date.now();
					log.info('LLM inference started', {
						conversationId: conversation.id,
						providerId: target.providerId,
						modelId: target.modelId,
						streamIndex: i,
						totalStreams: targets.length
					});
					const result = streamText({
						model,
						system,
						tools,
						messages: modelMessages,
						stopWhen,
						abortSignal: controller.signal,
						...(conversation.temperature != null ? { temperature: conversation.temperature } : {}),
						...(conversation.max_tokens != null
							? { maxOutputTokens: conversation.max_tokens }
							: {}),
						onError: ({ error }) => {
							errorText = error instanceof Error ? error.message : String(error);
							log.error('LLM stream error', {
								conversationId: conversation.id,
								providerId: target.providerId,
								modelId: target.modelId,
								error: errorText
							});
						}
					});
					const uiStream = result.toUIMessageStream({
						originalMessages: body.messages,
						generateMessageId: () => randomUUID()
					});
					for await (const chunk of uiStream) {
						const c = chunk as { type?: string };
						if (c.type === 'error') throw new Error(errorText ?? 'An error occurred');
						const isContent =
							c.type === 'text-delta' ||
							c.type === 'tool-input-start' ||
							c.type === 'tool-input-delta' ||
							c.type === 'tool-input-available';
						if (!isContent) {
							if (!contentful) buffer.push(chunk);
							else writer.write(chunk);
							continue;
						}
						if (!contentful) {
							contentful = true;
							for (const b of buffer) writer.write(b);
							buffer.length = 0;
						}
						writer.write(chunk);
					}
					totalTokensUsed = await result.usage;
					const priceRow = findModel(db, target.providerId, target.modelId);
					usageMeta = {
						providerId: target.providerId,
						modelId: target.modelId,
						inputTokens: totalTokensUsed?.inputTokens ?? null,
						outputTokens: totalTokensUsed?.outputTokens ?? null,
						totalTokens: totalTokensUsed?.totalTokens ?? null,
						latencyMs: Date.now() - startedAt,
						costUsd: computeCostUsd(
							priceRow?.price_input ?? null,
							priceRow?.price_output ?? null,
							totalTokensUsed?.inputTokens,
							totalTokensUsed?.outputTokens
						)
					};
					writer.write({
						type: 'message-metadata',
						messageMetadata: { usage: usageMeta }
					} as UIMessageChunk);
					log.info('LLM inference finished', {
						conversationId: conversation.id,
						streamIndex: i,
						inputTokens: totalTokensUsed?.inputTokens ?? null,
						outputTokens: totalTokensUsed?.outputTokens ?? null,
						totalTokens: totalTokensUsed?.totalTokens ?? null
					});
					return;
				} catch (e) {
					lastError = e;
					if (!contentful && i < targets.length - 1 && isRetryableModelError(e)) continue;
					throw e;
				}
			}
			throw lastError ?? new Error('No model produced a response');
		},
		onEnd: async ({ responseMessage, isAborted }) => {
			try {
				const status = isAborted ? 'partial' : errorText ? 'failed' : 'complete';
				if (responseMessage.parts.length > 0 || status !== 'failed') {
					createMessage(db, {
						id: responseMessage.id,
						conversationId: conversation.id,
						role: 'assistant',
						parts: responseMessage.parts,
						status,
						error: errorText,
						usage: usageMeta
					});
				}
				if (status === 'complete') {
					publishServerEvent(userId, {
						type: 'chat.message_completed',
						conversationId: conversation.id
					});
				}
				if (conversation.title === '') {
					const assistantText = extractText(responseMessage.parts);
					const userText = extractText(lastUserMessage.parts);
					generateConversationTitle(conversation.id, userId, ref, userText, assistantText).catch(
						() => undefined
					);
				}
			} catch (e) {
				log.error('Failed to persist assistant message', {
					conversationId: conversation.id,
					error: e instanceof Error ? e.message : String(e)
				});
			} finally {
				releaseStream(conversation.id, controller);
				publishServerEvent(userId, {
					type: 'chat.stream.finished',
					conversationId: conversation.id
				});
				await close();
			}
		}
	});

	return createUIMessageStreamResponse({ stream });
}
