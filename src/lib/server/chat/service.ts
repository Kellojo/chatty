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
	type ModelMessage,
	type UIMessage,
	type UIMessageChunk
} from 'ai';
import { config } from '../config.js';
import { getDb, type Db } from '../db/index.js';
import {
	getConversation,
	setConversationTitle,
	touchConversation,
	unsettleConversation,
	unsnoozeConversation,
	updateConversation,
	type ConversationRow
} from '../db/repo/conversations.js';
import {
	branchesFor,
	createMessage,
	deleteMessage,
	extractText,
	getMessage,
	toPublic,
	updateMessage,
	type MessageBranch,
	type MessageUsage
} from '../db/repo/messages.js';
import {
	getAttachment,
	getConversationAttachment,
	linkAttachmentsToMessage
} from '../db/repo/attachments.js';
import { getAgent, parseCanAsk } from '../db/repo/agents.js';
import { getAwaitingAgentRunByConversation, resumeAgentRun } from '../db/repo/agent-runs.js';
import { describeError } from '../agents/errors.js';
import {
	completeRunTurn,
	onRunConversationUnsettled,
	registerRunTurn,
	runTurnContext,
	runTurnsClosed,
	type RunTurnContext,
	type TurnOutcome
} from '../agents/run-lifecycle.js';
import {
	compactStepMessages,
	compactionThreshold,
	createRunSummarizer,
	estimateValueTokens
} from '../agents/stepCompaction.js';
import { openAskUserCall } from '$lib/ask-user.js';
import { ASK_USER_TOOL, askUserTool, withAskUserAnswers } from '../tools/askUser.js';
import { getCodingConversation } from '../db/repo/coding-conversations.js';
import { queueThreadStatePush } from '../t3/thread-state.js';
import { CodingTaskError, startCodingTurn } from '../t3/tasks.js';
import { loadUnsummarizedMessages } from '../db/repo/conversation-summaries.js';
import { findModel, findRoleModel } from '../db/repo/models.js';
import { getProvider } from '../db/repo/providers.js';
import { createProxyRequest, finalizeProxyRequest } from '../db/repo/proxy-requests.js';
import { cacheTokens, computeUsageCostUsd } from '../proxy/pricing.js';
import { getGlobalInstructions } from '../db/repo/user-settings.js';
import { publishServerEvent } from '../events/bus.js';
import { createLogger } from '../logger.js';
import { recordSkillInvocation } from '../db/repo/skill-invocations.js';
import { resolveModel, ModelUnavailableError } from '../llm/registry.js';
import { isRetryableModelError, resolveRefTargets } from '../llm/mapped.js';
import { buildSystemPromptParts } from '../llm/systemPrompt.js';
import { estimateMessagesChars, estimateToolChars } from '../llm/promptBreakdown.js';
import { withAnthropicPromptCache } from '../llm/promptCache.js';
import { resolveSkill } from '../skills/scanner.js';
import { buildTools } from '../tools/registry.js';
import {
	deferredToolsPrompt,
	loadedToolsFromHistory,
	supportsNativeToolSearch,
	withToolSearch
} from '../tools/toolSearch.js';
import {
	conversationWorkspace,
	resolveAttachment,
	workspaceForConversation
} from '../workspaces.js';
import { attachmentCache } from './attachmentCache.js';
import { estimateTokens, maybeCompactConversation } from './compact.js';
import { effectiveContextLength } from '../llm/lmstudio.js';
import {
	abortReasonOf,
	appendChunk,
	type AbortReason,
	claimStream,
	getStreamStartedAt,
	markDone,
	releaseStream
} from './streams.js';
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

/**
 * The client only ever sends text and its own uploads. A file part pointing
 * anywhere else (another conversation, an arbitrary URL the provider would
 * fetch) is rejected before anything is written.
 */
function assertValidUserParts(conversationId: string, message: UIMessage): void {
	for (const part of message.parts) {
		if (part.type === 'text') continue;
		if (part.type === 'file') {
			if (part.url.startsWith('data:')) continue;
			const id = attachmentIdFromUrl(part.url, conversationId);
			if (id && /^[\w-]+$/.test(id)) continue;
			throw new ChatRequestError(
				400,
				'File parts must reference an attachment of this conversation'
			);
		}
		throw new ChatRequestError(400, `Unsupported message part type "${part.type}"`);
	}
}

/** Images are only re-sent to the model for this many of the latest user turns. */
export const INLINE_IMAGE_USER_TURNS = 2;

/**
 * Index of the first message whose images are still sent inline: the
 * `turns`-th user message from the end (0 when there are fewer user turns).
 */
function inlineImagesFrom(messages: UIMessage[], turns: number): number {
	let seen = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role !== 'user') continue;
		seen++;
		if (seen === turns) return i;
	}
	return 0;
}

/**
 * Turns internal attachment URLs into what the provider can use. Images are
 * base64-inlined only for the latest INLINE_IMAGE_USER_TURNS user turns (and
 * the replies after them); older ones become a short note with the attachment
 * id, so tools can still reference them without re-sending the bytes.
 */
export async function inlineAttachmentParts(
	db: Db,
	conversationId: string,
	messages: UIMessage[],
	inlineImageTurns = INLINE_IMAGE_USER_TURNS
): Promise<UIMessage[]> {
	const inlineFrom = inlineImagesFrom(messages, inlineImageTurns);
	return await Promise.all(
		messages.map(async (message, index) => ({
			...message,
			parts: (
				await Promise.all(
					message.parts.map(async (part) => {
						if (part.type !== 'file') return [part];
						const attachmentId = attachmentIdFromUrl(part.url, conversationId);
						if (!attachmentId) return [part];
						const row = getConversationAttachment(db, conversationId, attachmentId);
						// An internal URL means nothing to the provider, so leave the part out.
						if (!row) return [];
						const isImage = row.mime.startsWith('image/');
						if (isImage && index < inlineFrom) {
							const name = part.filename ? ` ${part.filename}` : '';
							return [
								{
									type: 'text',
									text: `[earlier image${name} not re-sent; attachment id: ${attachmentId}]`
								} as UIMessage['parts'][number]
							];
						}
						const idNote = isImage
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
								const bytes = await fs.readFile(await resolveAttachment(row.path));
								dataUri = `data:${row.mime};base64,${bytes.toString('base64')}`;
								attachmentCache.set(attachmentId, dataUri);
							}
							return [...idNote, { ...part, url: dataUri }];
						} catch {
							// The internal URL is unfetchable for the provider and would fail
							// every later turn, so tell the model the file is gone instead.
							const name = part.filename ?? attachmentId;
							return [
								...idNote,
								{
									type: 'text',
									text: `[attachment unavailable: ${name}]`
								} as UIMessage['parts'][number]
							];
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
	const { summary, rows: visible } = loadUnsummarizedMessages(db, conversationId);
	// A failed response with no output only carries an error for the UI; an empty
	// assistant turn is not valid model input.
	const messages = visible.map(toPublic).flatMap((message) => {
		if (message.role === 'assistant' && message.parts.length === 0) return [];
		return {
			id: message.id,
			role: message.role,
			parts: message.parts as UIMessage['parts'],
			metadata: message.usage ? { usage: message.usage } : undefined
		};
	});
	if (!summary) return messages;
	return [
		{
			id: `summary-${summary.id}`,
			role: 'user' as const,
			parts: [
				{
					type: 'text' as const,
					text: `[Summary of earlier conversation]\n${summary.summary_text}`
				}
			]
		},
		...messages
	];
}

function upsertUserMessage(
	db: Db,
	conversationId: string,
	message: UIMessage,
	parentId?: string | null
): UIMessage {
	if (message.role !== 'user') {
		throw new ChatRequestError(400, 'Triggering message must be a user message');
	}
	const existing = getMessage(db, message.id);
	if (existing) {
		if (existing.conversation_id !== conversationId) {
			throw new ChatRequestError(400, 'Message does not belong to this conversation');
		}
		// Only the user's own messages may be rewritten (edit and regenerate resend them).
		if (existing.role !== 'user') {
			throw new ChatRequestError(400, 'Message id belongs to a non-user message');
		}
		updateMessage(db, message.id, { parts: message.parts, error: null, status: 'complete' });
	} else {
		createMessage(db, {
			id: message.id,
			conversationId,
			role: 'user',
			parts: message.parts,
			status: 'complete',
			parentId
		});
	}
	const attachmentIds = message.parts
		.filter((p) => p.type === 'file')
		.map((p) => attachmentIdFromUrl((p as { url: string }).url, conversationId))
		.filter((id): id is string => id !== null)
		.filter((id) => getConversationAttachment(db, conversationId, id) !== undefined);
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

/**
 * Disables tool calls on the last step the loop allows, so a reply that used
 * its whole step budget still ends with an answer instead of a dangling call.
 */
export function answerOnLastStep(maxSteps: number) {
	return ({ stepNumber }: { stepNumber: number }) =>
		stepNumber >= maxSteps - 1 ? { toolChoice: 'none' as const } : undefined;
}

const PERSIST_INTERVAL_MS = 500;

// Consumes the tee'd copy of the SSE stream: mirrors every chunk into the
// reconnect buffer and keeps the assistant row in the DB in sync (throttled)
// so a reload mid-stream sees the live, partially generated message.
async function consumeStreamCopy(
	conversationId: string,
	messageId: string,
	sseStream: ReadableStream<string>,
	controller: AbortController
): Promise<void> {
	const db = getDb();
	let lastPersist = 0;
	const persist = (parts: unknown[]) => {
		try {
			// This copy of the stream can lag behind the response. Once onEnd has
			// settled the message, a late snapshot must not overwrite its final parts.
			if (getMessage(db, messageId)?.status !== 'partial') return;
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
				if (parsed.success) appendChunk(conversationId, parsed.value as UIMessageChunk, controller);
			}
		})();

		const messageChunks = parseJsonEventStream({
			stream: messageBranch.pipeThrough(new TextEncoderStream()),
			schema: uiMessageChunkSchema
		}).pipeThrough(
			new TransformStream<{ success: boolean; value?: unknown }, UIMessageChunk>({
				transform(parsed, out) {
					if (parsed.success) out.enqueue(parsed.value as UIMessageChunk);
				}
			})
		);
		const uiStream = readUIMessageStream<UIMessage>({
			stream: messageChunks,
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
		markDone(conversationId, controller);
	}
}

/** Bookkeeping after a user message is stored: un-settle, wake, provisional title, bump. */
function afterUserMessage(
	db: Db,
	userId: string,
	conversation: ConversationRow,
	message: UIMessage
): void {
	if (conversation.settled_at !== null) {
		unsettleConversation(db, userId, conversation.id);
		publishServerEvent(userId, {
			type: 'conversation.settle_changed',
			conversationIds: [conversation.id],
			settled: false
		});
		queueThreadStatePush(db, userId, [conversation.id]);
	}
	// Writing in a snoozed chat means you're back on it.
	if (unsnoozeConversation(db, userId, conversation.id)) {
		publishServerEvent(userId, {
			type: 'conversation.snooze_changed',
			conversationIds: [conversation.id],
			snoozed: false
		});
		queueThreadStatePush(db, userId, [conversation.id]);
	}
	if (conversation.title === '') {
		const raw = extractText(message.parts).trim().replace(/\s+/g, ' ');
		let provisional: string;
		if (raw.length <= 50) {
			provisional = raw;
		} else {
			const cut = raw.lastIndexOf(' ', 50);
			provisional = (cut > 10 ? raw.slice(0, cut) : raw.slice(0, 50)) + '…';
		}
		setConversationTitle(db, conversation.id, provisional);
	}
	touchConversation(db, conversation.id);
}

/**
 * Stores the message a turn answers. Nothing is deleted: with `branchFrom` the
 * turn becomes an alternative version of that message, beside it in the tree.
 * - an edit (`branchFrom` is a user message): the sent message is stored as a
 *   new sibling of the edited one, with the same parent;
 * - a regenerate (`branchFrom` is a reply): the sent message must be the reply's
 *   own user message, which is kept as it is; the new reply becomes a sibling of
 *   the old one.
 * The reply is then created as the returned message's child, which makes that
 * branch the active one.
 */
function storeTurnMessage(
	db: Db,
	conversationId: string,
	body: { message: UIMessage; branchFrom?: string }
): UIMessage {
	if (body.branchFrom === undefined) return upsertUserMessage(db, conversationId, body.message);
	const anchor = getMessage(db, body.branchFrom);
	if (!anchor || anchor.conversation_id !== conversationId) {
		throw new ChatRequestError(400, 'branchFrom message not found in this conversation');
	}
	if (anchor.role === 'user') {
		if (getMessage(db, body.message.id)) {
			throw new ChatRequestError(400, 'An edited message must be sent under a new id');
		}
		return upsertUserMessage(db, conversationId, body.message, anchor.parent_id);
	}
	if (anchor.role !== 'assistant') {
		throw new ChatRequestError(400, 'branchFrom must be a user message or a reply');
	}
	const parent = anchor.parent_id ? getMessage(db, anchor.parent_id) : undefined;
	if (!parent || parent.id !== body.message.id || parent.role !== 'user') {
		throw new ChatRequestError(400, 'A regenerated reply must follow the message it answers');
	}
	// A reply that failed without any output is no version worth keeping.
	if (anchor.status !== 'partial' && anchor.parts === '[]') deleteMessage(db, anchor.id);
	const stored = toPublic(parent);
	return { id: stored.id, role: 'user', parts: stored.parts as UIMessage['parts'] };
}

/** Everything between claiming the conversation and building the prompt. */
async function prepareTurn(
	db: Db,
	userId: string,
	initial: ConversationRow,
	body: { message: UIMessage; branchFrom?: string },
	run: RunTurnContext | undefined
) {
	const conversation = ensureModel(db, userId, initial);
	const agent = conversation.agent_id ? getAgent(db, conversation.agent_id) : undefined;
	const lastUserMessage = storeTurnMessage(db, conversation.id, body);
	afterUserMessage(db, userId, conversation, lastUserMessage);

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

	const catalog = await buildTools({
		userId,
		memoryEnabled: conversation.memory_enabled === 1,
		workspaceDir:
			workspaceForConversation(db, conversation) ?? conversationWorkspace(conversation.id),
		agentAllowlist: agent?.tool_allowlist
			? (JSON.parse(agent.tool_allowlist) as string[])
			: undefined,
		author: run?.author,
		conversationId: conversation.id,
		agentRunId: run?.runId ?? null
	});
	// A run turn knows whether it may ask; in a chat the user talks to, an agent
	// that is allowed to ask can always do so.
	const askUser = run
		? run.askUser
		: !!agent && conversation.mode === 'agent' && parseCanAsk(agent) !== 'never';
	if (askUser) {
		// Always loaded and never filtered by the agent's allowlist: it's how the
		// agent reaches the user, not a capability.
		catalog.tools[ASK_USER_TOOL] = askUserTool();
		catalog.toolToServer[ASK_USER_TOOL] = 'chatty';
	}
	return { conversation, agent, lastUserMessage, ref, targets: available, catalog };
}

export interface ChatTurnRequest {
	message: UIMessage;
	branchFrom?: string;
	skill?: string;
}

export interface ChatTurnOptions {
	/** Runs the turn for this agent run (dispatched, or resumed by the runner). */
	run?: RunTurnContext;
}

export interface ChatTurn {
	response: Response;
	/** Resolves once the turn has ended and been persisted (and its run settled). */
	outcome: Promise<TurnOutcome>;
}

/**
 * A reply to a dispatched chat whose run waits for an answer continues that
 * run: the turn is attributed to it and settles it again when it ends. Called
 * after the conversation was claimed, so a superseded run turn has already
 * settled its status.
 */
function resumedRunTurn(
	db: Db,
	userId: string,
	conversation: ConversationRow,
	body: ChatTurnRequest
): RunTurnContext | undefined {
	if (conversation.origin !== 'dispatch') return undefined;
	// Replying to a settled chat brings it back (see afterUserMessage), and with
	// it a question that settling dismissed: the reply answers it.
	if (conversation.settled_at !== null) onRunConversationUnsettled(db, userId, conversation.id);
	const run = getAwaitingAgentRunByConversation(db, conversation.id);
	if (!run || run.user_id !== userId) return undefined;
	const agent = getAgent(db, run.agent_id);
	if (!agent || !resumeAgentRun(db, run.id)) return undefined;
	publishServerEvent(userId, {
		type: 'agent.run.started',
		agentId: agent.id,
		runId: run.id,
		conversationId: conversation.id
	});
	// An edit or regenerate rewinds the run instead of answering its question.
	return runTurnContext(db, agent, run, {
		resumed: body.branchFrom === undefined,
		userTurn: true
	});
}

/**
 * Runs one model turn in a conversation: stores the user message, streams the
 * reply (persisted as it goes, replayable to reconnecting clients) and settles
 * the agent run it belongs to, if any. Throws ChatRequestError for problems with
 * the request; once it returns, `outcome` always resolves.
 */
export async function runChatTurn(
	userId: string,
	initial: ConversationRow,
	body: ChatTurnRequest,
	opts: ChatTurnOptions = {}
): Promise<ChatTurn> {
	const db = getDb();
	let conversation = initial;
	// Only conversations the user sees take part in chat events (active list,
	// notices, agent triggers); hidden agent runs report through run events.
	const visibleChat = conversation.kind === 'chat';

	// A new message takes over from a response that is still running. Its partial
	// output has to be persisted first so that it is part of the history below.
	// The claim is taken before any await of our own, so a concurrent request for
	// this conversation waits for (and aborts) this one instead of racing it.
	const controller = await claimStream(conversation.id);
	const run = opts.run ?? resumedRunTurn(db, userId, conversation, body);
	const releaseRun = run ? registerRunTurn(run.runId, conversation.id) : () => undefined;
	// Shutdown may have swept the running turns before this one registered.
	if (run && runTurnsClosed()) controller.abort('shutdown' satisfies AbortReason);
	const describe = (e: unknown) =>
		run ? describeError(e) : e instanceof Error ? e.message : String(e);
	/** Ends the run of a turn that failed before its stream took over. */
	const settleEarly = (outcome: TurnOutcome) => {
		if (run) completeRunTurn(db, run, conversation, outcome);
		releaseRun();
	};

	let turn: Awaited<ReturnType<typeof prepareTurn>>;
	try {
		turn = await prepareTurn(db, userId, conversation, body, run);
	} catch (e) {
		releaseStream(conversation.id, controller);
		settleEarly({ status: 'failed', error: describe(e), abortReason: null, openAskUser: null });
		throw e;
	}
	const { agent, lastUserMessage, ref, targets, catalog } = turn;
	const { tools, close } = catalog;
	conversation = turn.conversation;
	if (controller.signal.aborted) {
		// A newer request took over while the tools were being built.
		releaseStream(conversation.id, controller);
		settleEarly({
			status: 'aborted',
			error: null,
			abortReason: abortReasonOf(controller.signal),
			openAskUser: null
		});
		await close().catch(() => undefined);
		throw new ChatRequestError(409, 'Superseded by a newer message');
	}
	if (visibleChat) {
		publishServerEvent(userId, {
			type: 'chat.stream.started',
			conversationId: conversation.id,
			startedAt: getStreamStartedAt(conversation.id) ?? Date.now()
		});
	}

	// The assistant message exists from the start and is filled incrementally by
	// consumeStreamCopy, so a reload mid-stream never sees a gap.
	const assistantMessageId = randomUUID();
	let errorText: string | null = null;
	let replyBranch: MessageBranch | undefined;
	let promptParts: ReturnType<typeof buildSystemPromptParts>;
	let system: string;
	let history: UIMessage[];
	let promptHistory: UIMessage[];
	let toolsSection: string;
	// Until createUIMessageStream takes over (its onEnd releases everything), a
	// throw here would leave the stream registered as active forever and the MCP
	// connections open, so undo the setup by hand.
	try {
		createMessage(db, {
			id: assistantMessageId,
			conversationId: conversation.id,
			role: 'assistant',
			parts: [],
			status: 'partial',
			parentId: lastUserMessage.id
		});
		// A regenerated reply has older versions: the client shows its switcher.
		replyBranch = branchesFor(db, conversation.id, [{ id: assistantMessageId }]).get(
			assistantMessageId
		);
		// The edit or regenerate is now the shown version; other tabs redraw.
		if (body.branchFrom !== undefined) {
			publishServerEvent(userId, {
				type: 'conversation.branch_changed',
				conversationId: conversation.id
			});
		}

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
		promptParts = buildSystemPromptParts(conversation, {
			// Hidden agent runs get neither: nobody renders widgets there, and the
			// user's instructions would leak into what memory agents distill.
			globalInstructions: visibleChat ? getGlobalInstructions(db, userId) : '',
			includeWidgets: visibleChat,
			userId,
			boundSkillNames,
			includeSkillsIndex: 'load_skill' in tools,
			extraWarning: manualSkillWarning,
			toolNames: Object.keys(tools)
		});
		toolsSection = deferredToolsPrompt(catalog);
		system = [
			promptParts.base,
			promptParts.widgets,
			promptParts.skills,
			toolsSection,
			promptParts.system,
			run?.header ?? ''
		]
			.filter(Boolean)
			.join('\n\n');
		history = historyFromDb(db, conversation.id);
		promptHistory = withAskUserAnswers(await inlineAttachmentParts(db, conversation.id, history));
	} catch (e) {
		try {
			deleteMessage(db, assistantMessageId);
		} catch {
			// nothing to clean up if the message was never created
		}
		releaseStream(conversation.id, controller);
		settleEarly({ status: 'failed', error: describe(e), abortReason: null, openAskUser: null });
		if (visibleChat) {
			publishServerEvent(userId, { type: 'chat.stream.finished', conversationId: conversation.id });
		}
		await close().catch(() => undefined);
		throw e;
	}
	const maxSteps =
		conversation.mode === 'agent' ? (conversation.max_steps ?? config.AGENT_MAX_STEPS) : 5;
	const stopWhen = stepCountIs(maxSteps);
	const lastStep = answerOnLastStep(maxSteps);
	const loadedTools = loadedToolsFromHistory(history, catalog.deferred);

	let usageMeta: MessageUsage | null = null;
	let lastProgressAt = 0;
	/** Lets a run's page refresh while its turn streams (throttled). */
	const reportProgress = () => {
		if (!run) return;
		const now = Date.now();
		if (now - lastProgressAt < 500) return;
		lastProgressAt = now;
		publishServerEvent(userId, {
			type: 'agent.run.progress',
			agentId: run.agentId,
			runId: run.runId
		});
	};

	let resolveOutcome!: (outcome: TurnOutcome) => void;
	const outcome = new Promise<TurnOutcome>((resolve) => (resolveOutcome = resolve));

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
				// A failed earlier target must not mark a successful fallback as failed.
				errorText = null;
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
							// A run's turns count as the run's cost, replies included.
							source: run ? 'agent' : 'chat',
							conversationId: conversation.id,
							messageId: assistantMessageId,
							runId: run?.runId,
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
							...cacheTokens(patch.usage),
							costUsd: computeUsageCostUsd(priceRow, patch.usage),
							error: patch.error ?? null
						});
						lastStepAt = now;
					};
					log.info('LLM inference started', {
						conversationId: conversation.id,
						runId: run?.runId,
						providerId: target.providerId,
						modelId: target.modelId,
						streamIndex: i,
						totalStreams: targets.length
					});
					// Targets can be fallbacks on other providers, so decide per target.
					const providerType = getProvider(db, target.providerId)?.type;
					const toolSearch = withToolSearch(catalog, {
						native: supportsNativeToolSearch(providerType, target.modelId),
						loaded: loadedTools
					});
					// An interrupted response can leave tool calls without results, which
					// providers reject, so they are left out of the prompt.
					const modelMessages = await convertToModelMessages(promptHistory, {
						ignoreIncompleteToolCalls: true,
						tools: toolSearch.historyTools
					});
					const prompt =
						providerType === 'anthropic'
							? withAnthropicPromptCache({
									system,
									messages: modelMessages,
									tools: toolSearch.tools
								})
							: { system, messages: modelMessages, tools: toolSearch.tools };
					const compactSteps = run
						? stepCompactor({
								db,
								userId,
								conversationId: conversation.id,
								runId: run.runId,
								target,
								contextLength: () => effectiveContextLength(target),
								overheadTokens:
									estimateTokens(system) + Math.ceil(estimateToolChars(toolSearch.tools) / 4),
								abortSignal: controller.signal
							})
						: null;
					const result = streamText({
						model,
						...prompt,
						stopWhen,
						experimental_repairToolCall: toolSearch.repairToolCall,
						prepareStep: async (options) => {
							const activeTools = toolSearch.activeTools();
							const base = lastStep(options);
							const messages = compactSteps ? await compactSteps(options) : undefined;
							return {
								...base,
								...(activeTools ? { activeTools } : {}),
								...(messages ? { messages } : {})
							};
						},
						abortSignal: controller.signal,
						...(conversation.temperature != null ? { temperature: conversation.temperature } : {}),
						...(conversation.max_tokens != null
							? { maxOutputTokens: conversation.max_tokens }
							: {}),
						onStepEnd: (step) => {
							recordStep({ status: 'complete', usage: step.usage });
							for (const tr of step.toolResults) {
								if (tr.toolName === 'generate_image' || tr.toolName === 'edit_image') {
									// Only ids belonging to this conversation: tool output is untrusted.
									const ids = attachmentIdsFromOutput(tr.output).filter(
										(id) => getConversationAttachment(db, conversation.id, id) !== undefined
									);
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
							}
						},
						onError: ({ error }) => {
							errorText = describe(error);
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
						generateMessageId: () => assistantMessageId,
						// A regenerated reply has older versions, so the client shows its
						// switcher. Sent on the reply's own `start` chunk: a metadata chunk
						// ahead of `start` makes the client add a second, empty message.
						messageMetadata: ({ part }) =>
							part.type === 'start' && replyBranch ? { branch: replyBranch } : undefined
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
						reportProgress();
					}
					totalTokensUsed = await result.usage;
					usageMeta = {
						providerId: target.providerId,
						modelId: target.modelId,
						inputTokens: totalTokensUsed?.inputTokens ?? null,
						outputTokens: totalTokensUsed?.outputTokens ?? null,
						totalTokens: totalTokensUsed?.totalTokens ?? null,
						latencyMs: Date.now() - startedAt,
						costUsd: computeUsageCostUsd(priceRow, totalTokensUsed),
						promptChars: {
							system:
								promptParts.base.length + promptParts.widgets.length + promptParts.system.length,
							skills: promptParts.skills.length,
							tools: estimateToolChars(toolSearch.promptTools()) + toolsSection.length,
							messages: estimateMessagesChars(history)
						}
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
					// Errors thrown outside streamText (e.g. resolving the model) never reach
					// its onError, so record them here for onEnd's status.
					errorText ??= describe(e);
					throw e;
				}
			}
			throw lastError ?? new Error('No model produced a response');
		},
		onEnd: async ({ responseMessage, isAborted }) => {
			// A provider may surface an abort as an error; our abort reason wins.
			const abortReason = abortReasonOf(controller.signal);
			const aborted = isAborted || abortReason !== null;
			const turnOutcome: TurnOutcome = {
				status: aborted ? 'aborted' : errorText ? 'failed' : 'complete',
				error: aborted ? null : errorText,
				abortReason,
				openAskUser: aborted || errorText ? null : openAskUserCall(responseMessage.parts)
			};
			try {
				// 'partial' only ever means "still being generated", so that anything
				// left in that state after a restart is known to be a dead response.
				const status = isAborted || errorText ? 'failed' : 'complete';
				// A failure is kept even without output so the error stays visible in the
				// conversation; only an empty interrupted response is dropped.
				if (responseMessage.parts.length > 0 || status === 'complete' || errorText) {
					updateMessage(db, assistantMessageId, {
						parts: responseMessage.parts,
						status,
						error: isAborted ? 'Response interrupted' : errorText,
						usage: usageMeta
					});
				} else {
					deleteMessage(db, assistantMessageId);
				}
				if (status === 'complete' && visibleChat) {
					publishServerEvent(userId, {
						type: 'chat.message_completed',
						conversationId: conversation.id,
						...(run ? { agentRunId: run.runId } : {})
					});
				}
				if (conversation.title === '') {
					const assistantText = extractText(responseMessage.parts);
					const userText = extractText(lastUserMessage.parts);
					generateConversationTitle(conversation.id, userId, ref, userText, assistantText).catch(
						() => undefined
					);
				}
				// Hidden runs are single turns: compacting them only costs a call.
				if (status === 'complete' && visibleChat) {
					maybeCompactConversation(conversation, userId, ref).catch(() => undefined);
				}
			} catch (e) {
				log.error('Failed to persist assistant message', {
					conversationId: conversation.id,
					error: e instanceof Error ? e.message : String(e)
				});
			} finally {
				// Settled before the stream is released: a reply waiting on this claim
				// then sees the run's final status.
				if (run) completeRunTurn(db, run, conversation, turnOutcome);
				releaseStream(conversation.id, controller);
				releaseRun();
				if (visibleChat) {
					publishServerEvent(userId, {
						type: 'chat.stream.finished',
						conversationId: conversation.id
					});
				}
				await close().catch(() => undefined);
				resolveOutcome(turnOutcome);
			}
		}
	});

	const response = createUIMessageStreamResponse({
		stream,
		consumeSseStream: ({ stream: sseStream }) => {
			void consumeStreamCopy(conversation.id, assistantMessageId, sseStream, controller);
		}
	});
	return { response, outcome };
}

/**
 * Runs a turn nobody is listening to (an agent run): drains the response
 * itself and returns how the turn ended. Never throws.
 */
export async function runChatTurnHeadless(
	userId: string,
	conversation: ConversationRow,
	body: ChatTurnRequest,
	opts: ChatTurnOptions = {}
): Promise<TurnOutcome> {
	let turn: ChatTurn;
	try {
		turn = await runChatTurn(userId, conversation, body, opts);
	} catch (e) {
		// runChatTurn has settled the run already.
		return {
			status: 'failed',
			error: opts.run ? describeError(e) : e instanceof Error ? e.message : String(e),
			abortReason: null,
			openAskUser: null
		};
	}
	const reader = turn.response.body?.getReader();
	if (reader) {
		try {
			while (!(await reader.read()).done) {
				// draining: persistence runs off the tee'd copy of this stream
			}
		} catch {
			// the turn's own error handling records failures
		}
	}
	return turn.outcome;
}

/**
 * The context-size guard for a run's long tool loops: once a step's prompt
 * nears the model's context, older steps are folded into a summary (see
 * stepCompaction). Returns the messages to use for the next step, if changed.
 */
function stepCompactor(input: {
	db: Db;
	userId: string;
	conversationId: string;
	runId: string;
	target: { providerId: string; modelId: string };
	/** Asked per step: an LM Studio model's loaded context can change mid-run. */
	contextLength: () => Promise<number | null>;
	overheadTokens: number;
	abortSignal: AbortSignal;
}) {
	if (compactionThreshold(null) === null) return null;
	const summarize = createRunSummarizer({
		db: input.db,
		userId: input.userId,
		conversationId: input.conversationId,
		runId: input.runId,
		fallback: input.target,
		abortSignal: input.abortSignal
	});
	return async ({
		messages,
		steps
	}: {
		messages: ModelMessage[];
		steps: ReadonlyArray<{
			usage: { inputTokens?: number | undefined };
			response: { messages: unknown[] };
		}>;
	}): Promise<ModelMessage[] | undefined> => {
		// The last step's measured input plus what it added is more accurate than
		// a character estimate (it includes system, tools and images).
		const last = steps.at(-1);
		const measured = last?.usage.inputTokens
			? last.usage.inputTokens + estimateValueTokens(last.response.messages)
			: 0;
		const promptTokens = measured || input.overheadTokens + estimateValueTokens(messages);
		const threshold = compactionThreshold(await input.contextLength());
		if (threshold === null) return undefined;
		const c = await compactStepMessages({
			messages,
			promptTokens,
			thresholdTokens: threshold,
			summarize
		});
		if (c.stage === 'none') return undefined;
		log.info('Agent run context compacted', {
			runId: input.runId,
			stage: c.stage,
			beforeTokens: c.beforeTokens,
			afterTokens: c.afterTokens,
			elided: c.elided,
			truncated: c.truncated,
			foldedSteps: c.foldedSteps
		});
		return c.messages;
	};
}

export async function handleChatRequest(
	userId: string,
	body: ChatTurnRequest & { conversationId: string }
): Promise<Response> {
	const db = getDb();
	const conversation = getConversation(db, userId, body.conversationId);
	if (!conversation) throw new ChatRequestError(404, 'Conversation not found');
	if (conversation.kind !== 'chat') throw new ChatRequestError(400, 'Not a chat conversation');
	if (body.message.role !== 'user') {
		throw new ChatRequestError(400, 'Triggering message must be a user message');
	}
	assertValidUserParts(conversation.id, body.message);

	// Coding tasks: the reply comes from a remote T3 Code thread, not our model loop.
	const coding = getCodingConversation(db, conversation.id);
	if (coding) {
		if (body.branchFrom !== undefined) {
			throw new ChatRequestError(400, 'Coding tasks cannot rewind their history');
		}
		const userMessage = upsertUserMessage(db, conversation.id, body.message);
		afterUserMessage(db, userId, conversation, userMessage);
		try {
			return await startCodingTurn(userId, coding, userMessage);
		} catch (e) {
			if (e instanceof CodingTaskError) throw new ChatRequestError(e.status, e.message);
			throw e;
		}
	}

	const { response } = await runChatTurn(userId, conversation, {
		message: body.message,
		branchFrom: body.branchFrom,
		skill: body.skill
	});
	return response;
}
