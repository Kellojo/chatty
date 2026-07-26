import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
	convertToModelMessages,
	createUIMessageStream,
	createUIMessageStreamResponse,
	parseJsonEventStream,
	readUIMessageStream,
	stepCountIs,
	streamText,
	uiMessageChunkSchema,
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
	deleteMessage,
	deleteMessagesFrom,
	extractText,
	getMessage,
	listMessages,
	toPublic,
	updateMessage,
	type MessageUsage
} from '../db/repo/messages.js';
import { getAttachment, linkAttachmentsToMessage } from '../db/repo/attachments.js';
import { getAgent } from '../db/repo/agents.js';
import { findModel, findRoleModel } from '../db/repo/models.js';
import { getProvider } from '../db/repo/providers.js';
import { createProxyRequest, finalizeProxyRequest } from '../db/repo/proxy-requests.js';
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
import { appendChunk, markDone, registerStream, releaseStream } from './streams.js';
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

async function inlineAttachmentParts(
	db: Db,
	conversationId: string,
	messages: UIMessage[]
): Promise<UIMessage[]> {
	return await Promise.all(
		messages.map(async (message) => ({
			...message,
			parts: (
				await Promise.all(
					message.parts.map(async (part) => {
						if (part.type !== 'file') return [part];
						const attachmentId = attachmentIdFromUrl(part.url, conversationId);
						if (!attachmentId) return [part];
						const row = getAttachment(db, attachmentId);
						if (!row) return [part];
						const idNote = row.mime.startsWith('image/')
							? [
									{
										type: 'text',
										text: `[attachment id: ${attachmentId}]`
									} as UIMessage['parts'][number]
								]
							: [];
						try {
							let dataUri = attachmentCache.get(attachmentId);
							if (dataUri === undefined) {
								const bytes = await fs.readFile(resolveAttachment(row.path));
								dataUri = `data:${row.mime};base64,${bytes.toString('base64')}`;
								attachmentCache.set(attachmentId, dataUri);
							}
							return [...idNote, { ...part, url: dataUri }];
						} catch {
							return [...idNote, part];
						}
					})
				)
			).flat()
		}))
	);
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

function historyFromDb(db: Db, conversationId: string): UIMessage[] {
	return listMessages(db, conversationId).map((row) => {
		const message = toPublic(row);
		return {
			id: message.id,
			role: message.role,
			parts: message.parts as UIMessage['parts'],
			metadata: message.usage ? { usage: message.usage } : undefined
		};
	});
}

function upsertUserMessage(db: Db, conversationId: string, message: UIMessage): UIMessage {
	if (message.role !== 'user') {
		throw new ChatRequestError(400, 'Triggering message must be a user message');
	}
	const existing = getMessage(db, message.id);
	if (existing) {
		if (existing.conversation_id !== conversationId) {
			throw new ChatRequestError(400, 'Message does not belong to this conversation');
		}
		updateMessage(db, message.id, { parts: message.parts, error: null, status: 'complete' });
	} else {
		createMessage(db, {
			id: message.id,
			conversationId,
			role: 'user',
			parts: message.parts,
			status: 'complete'
		});
	}
	const attachmentIds = message.parts
		.filter((p) => p.type === 'file')
		.map((p) => attachmentIdFromUrl((p as { url: string }).url, conversationId))
		.filter((id): id is string => id !== null);
	linkAttachmentsToMessage(db, message.id, attachmentIds);
	return message;
}

function attachmentIdsFromOutput(output: unknown): string[] {
	if (typeof output !== 'object' || output === null) return [];
	const sc = (output as { structuredContent?: unknown }).structuredContent;
	if (typeof sc !== 'object' || sc === null) return [];
	const ids = (sc as { attachmentIds?: unknown }).attachmentIds;
	if (!Array.isArray(ids)) return [];
	return ids.filter((id): id is string => typeof id === 'string');
}

const PERSIST_INTERVAL_MS = 500;

// Consumes the tee'd copy of the SSE stream: mirrors every chunk into the
// reconnect buffer and keeps the assistant row in the DB in sync (throttled)
// so a reload mid-stream sees the live, partially generated message.
async function consumeStreamCopy(
	conversationId: string,
	messageId: string,
	sseStream: ReadableStream<string>
): Promise<void> {
	const db = getDb();
	let lastPersist = 0;
	const persist = (parts: unknown[]) => {
		try {
			updateMessage(db, messageId, { parts });
		} catch (e) {
			log.error('Failed to persist streaming assistant message', {
				conversationId,
				error: e instanceof Error ? e.message : String(e)
			});
		}
	};
	try {
		// Tee again: one branch replays raw chunks into the reconnect buffer, the
		// other reconstructs the live message for throttled DB persistence.
		const [rawBranch, messageBranch] = sseStream.tee();
		const rawChunks = parseJsonEventStream({
			stream: rawBranch.pipeThrough(new TextEncoderStream()),
			schema: uiMessageChunkSchema
		});
		const mirror = (async () => {
			for await (const parsed of rawChunks) {
				if (parsed.success) appendChunk(conversationId, parsed.value as UIMessageChunk);
			}
		})();

		const messageChunks = parseJsonEventStream({
			stream: messageBranch.pipeThrough(new TextEncoderStream()),
			schema: uiMessageChunkSchema
		});
		const uiStream = readUIMessageStream<UIMessage>({
			stream: messageChunks as unknown as ReadableStream<UIMessageChunk>,
			onError: () => undefined
		});
		for await (const message of uiStream) {
			if (message.parts.length === 0) continue;
			const now = Date.now();
			if (now - lastPersist >= PERSIST_INTERVAL_MS) {
				lastPersist = now;
				persist(message.parts);
			}
		}
		await mirror;
	} catch {
		// the main response stream failing is handled by onEnd/onError
	} finally {
		markDone(conversationId);
	}
}

export async function handleChatRequest(
	userId: string,
	body: { conversationId: string; message: UIMessage; truncateFrom?: string; skill?: string }
): Promise<Response> {
	const db = getDb();
	let conversation = getConversation(db, userId, body.conversationId);
	if (!conversation) throw new ChatRequestError(404, 'Conversation not found');
	if (conversation.kind !== 'chat') throw new ChatRequestError(400, 'Not a chat conversation');

	conversation = ensureModel(db, userId, conversation);
	const agent = conversation.agent_id ? getAgent(db, conversation.agent_id) : undefined;
	if (body.truncateFrom !== undefined) {
		const anchor = getMessage(db, body.truncateFrom);
		if (!anchor || anchor.conversation_id !== conversation.id) {
			throw new ChatRequestError(400, 'truncateFrom message not found in this conversation');
		}
		deleteMessagesFrom(db, conversation.id, body.truncateFrom);
	}
	const lastUserMessage = upsertUserMessage(db, conversation.id, body.message);
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

	// The assistant message exists from the start and is filled incrementally by
	// consumeStreamCopy, so a reload mid-stream never sees a gap.
	const assistantMessageId = randomUUID();
	createMessage(db, {
		id: assistantMessageId,
		conversationId: conversation.id,
		role: 'assistant',
		parts: [],
		status: 'partial'
	});

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
	const history = historyFromDb(db, conversation.id);
	const modelMessages = await convertToModelMessages(
		await inlineAttachmentParts(db, conversation.id, history)
	);
	const stopWhen = stepCountIs(
		conversation.mode === 'agent' ? (conversation.max_steps ?? config.AGENT_MAX_STEPS) : 5
	);

	let usageMeta: MessageUsage | null = null;

	const stream = createUIMessageStream<UIMessage>({
		originalMessages: history,
		generateId: () => assistantMessageId,
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
					let stepIndex = 0;
					let lastStepAt = startedAt;
					const priceRow = findModel(db, target.providerId, target.modelId);
					const recordStep = (patch: {
						status: 'complete' | 'failed';
						usage?: { inputTokens?: number | null; outputTokens?: number | null };
						error?: string | null;
					}) => {
						const now = Date.now();
						const row = createProxyRequest(db, {
							userId,
							source: 'chat',
							conversationId: conversation.id,
							messageId: assistantMessageId,
							stepIndex: stepIndex++,
							endpoint: 'streamText',
							requestedModel: target.modelId,
							stream: true
						});
						finalizeProxyRequest(db, row.id, {
							status: patch.status,
							latencyMs: now - lastStepAt,
							providerId: target.providerId,
							modelId: target.modelId,
							inputTokens: patch.usage?.inputTokens ?? null,
							outputTokens: patch.usage?.outputTokens ?? null,
							costUsd: computeCostUsd(
								priceRow?.price_input ?? null,
								priceRow?.price_output ?? null,
								patch.usage?.inputTokens,
								patch.usage?.outputTokens
							),
							error: patch.error ?? null
						});
						lastStepAt = now;
					};
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
						onStepEnd: (step) => {
							recordStep({ status: 'complete', usage: step.usage });
							for (const tr of step.toolResults) {
								if (tr.toolName !== 'generate_image' && tr.toolName !== 'edit_image') continue;
								const ids = attachmentIdsFromOutput(tr.output);
								if (ids.length === 0) continue;
								linkAttachmentsToMessage(db, assistantMessageId, ids);
								for (const id of ids) {
									const row = getAttachment(db, id);
									if (!row) continue;
									writer.write({
										type: 'file',
										url: `${ATTACHMENT_URL_PREFIX}${conversation.id}/attachments/${id}`,
										mediaType: row.mime
									} as UIMessageChunk);
								}
							}
						},
						onError: ({ error }) => {
							errorText = error instanceof Error ? error.message : String(error);
							log.error('LLM stream error', {
								conversationId: conversation.id,
								providerId: target.providerId,
								modelId: target.modelId,
								error: errorText
							});
							recordStep({ status: 'failed', error: errorText });
						}
					});
					const uiStream = result.toUIMessageStream({
						originalMessages: history,
						generateMessageId: () => assistantMessageId
					});
					for await (const chunk of uiStream) {
						const c = chunk as { type?: string };
						if (c.type === 'error') throw new Error(errorText ?? 'An error occurred');
						// Only the leading `start` chunk is pure framing; everything else is
						// model output. Buffering only `start` lets us still retry the next
						// target if this one errors before producing anything, while
						// guaranteeing no real output is ever dropped.
						if (c.type === 'start' && !contentful) {
							buffer.push(chunk);
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
					updateMessage(db, assistantMessageId, {
						parts: responseMessage.parts,
						status,
						error: errorText,
						usage: usageMeta
					});
				} else {
					deleteMessage(db, assistantMessageId);
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

	return createUIMessageStreamResponse({
		stream,
		consumeSseStream: ({ stream: sseStream }) => {
			void consumeStreamCopy(conversation.id, assistantMessageId, sseStream);
		}
	});
}
