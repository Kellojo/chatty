import { generateText, type UIMessage } from 'ai';
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { createSummary, unsummarizedMessages } from '../db/repo/conversation-summaries.js';
import type { ConversationRow } from '../db/repo/conversations.js';
import { listMessages, type MessageRow } from '../db/repo/messages.js';
import { estimateMessagesChars } from '../llm/promptBreakdown.js';
import { findModel, findRoleModel, type ModelRow } from '../db/repo/models.js';
import { createProxyRequest, finalizeProxyRequest } from '../db/repo/proxy-requests.js';
import { publishServerEvent } from '../events/bus.js';
import { resolveModel } from '../llm/registry.js';
import { resolveRefTargets } from '../llm/mapped.js';
import { createLogger } from '../logger.js';
import { cacheTokens, computeUsageCostUsd } from '../proxy/pricing.js';

const log = createLogger('chat-compact');

const CHARS_PER_TOKEN = 4;
const SAFETY_MARGIN = 0.85;
const RESPONSE_RESERVE_TOKENS = 4096;
const MIN_THRESHOLD_TOKENS = 4000;
const SUMMARY_TARGET_TOKENS = 2000;

// The trailing keep-window is never folded, so a few huge messages in it (e.g.
// a 1MB webfetch result) would keep the prompt over budget forever. It is
// shrunk until it fits in this share of the threshold, down to MIN_KEEP.
const KEEP_WINDOW_SHARE = 0.5;
const MIN_KEEP_MESSAGES = 2;
// Per tool input/output in the summarization transcript.
const TRANSCRIPT_TOOL_CHARS = 2000;

export function estimateTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function messageParts(m: MessageRow): UIMessage['parts'] {
	return JSON.parse(m.parts) as UIMessage['parts'];
}

/** Everything that is sent to the model for a message: text, reasoning, tool calls and results. */
export function estimateMessageTokens(m: MessageRow): number {
	return Math.ceil(
		estimateMessagesChars([{ id: m.id, role: 'user', parts: messageParts(m) }]) / CHARS_PER_TOKEN
	);
}

function truncate(text: string, max: number): string {
	return text.length <= max
		? text
		: `${text.slice(0, max)}… [${text.length - max} chars truncated]`;
}

function serialize(value: unknown): string {
	if (typeof value === 'string') return value;
	try {
		return JSON.stringify(value) ?? '';
	} catch {
		return String(value);
	}
}

/** Transcript lines for a message: its text plus tool calls/results, each truncated. */
export function messageTranscript(m: MessageRow): string {
	const lines: string[] = [];
	for (const part of messageParts(m)) {
		const p = part as {
			type: string;
			text?: string;
			toolName?: string;
			input?: unknown;
			output?: unknown;
			errorText?: string;
			filename?: string;
		};
		if (p.type === 'text' && p.text?.trim()) {
			lines.push(p.text);
		} else if (p.type === 'dynamic-tool' || p.type.startsWith('tool-')) {
			const name = p.type === 'dynamic-tool' ? (p.toolName ?? 'tool') : p.type.slice(5);
			const input =
				p.input === undefined ? '' : truncate(serialize(p.input), TRANSCRIPT_TOOL_CHARS);
			lines.push(`[tool call ${name}] ${input}`.trimEnd());
			if (p.output !== undefined) {
				lines.push(`[tool result ${name}] ${truncate(serialize(p.output), TRANSCRIPT_TOOL_CHARS)}`);
			} else if (p.errorText) {
				lines.push(`[tool error ${name}] ${truncate(p.errorText, TRANSCRIPT_TOOL_CHARS)}`);
			}
		} else if (p.type === 'file') {
			lines.push(`[file${p.filename ? `: ${p.filename}` : ''}]`);
		}
	}
	return lines.join('\n');
}

export function compactThreshold(
	conversation: ConversationRow,
	model: ModelRow | undefined,
	keepMessages: number
): number | null {
	if (config.CHAT_COMPACT_TOKENS === 0) return null;
	const reserve = conversation.max_tokens ?? RESPONSE_RESERVE_TOKENS;
	if (model?.context_length && model.context_length > 0) {
		const budget = Math.floor((model.context_length - reserve) * SAFETY_MARGIN);
		return Math.max(budget, MIN_THRESHOLD_TOKENS, keepMessages * 400);
	}
	return config.CHAT_COMPACT_TOKENS;
}

function summaryTarget(fallback: { providerId: string; modelId: string }): {
	providerId: string;
	modelId: string;
} {
	const db = getDb();
	const role = findRoleModel(db, 'compaction');
	if (role) {
		return resolveRefTargets({ providerId: role.provider_id, modelId: role.model_id }, db)
			.targets[0];
	}
	return resolveRefTargets(fallback, db).targets[0];
}

const SUMMARY_PROMPT = `You are compressing conversation history to fit a context window. Summarize the conversation so far, preserving:
- decisions made and their rationale
- facts, entities, names, code, and configurations mentioned
- user preferences and constraints
- open questions, tasks, and pending tool results still relevant

Be concise but complete; write in third person. Output only the summary.`;

export async function maybeCompactConversation(
	conversation: ConversationRow,
	userId: string,
	fallbackRef: { providerId: string; modelId: string }
): Promise<void> {
	const db = getDb();
	const keep =
		conversation.mode === 'agent'
			? Math.max(config.CHAT_COMPACT_KEEP_MESSAGES, 20)
			: config.CHAT_COMPACT_KEEP_MESSAGES;

	const model = findModel(db, fallbackRef.providerId, fallbackRef.modelId);
	const threshold = compactThreshold(conversation, model, keep);
	if (threshold === null) return;

	// 'partial' is a response still being generated; dead ones are settled at
	// startup by finalizeInterruptedMessages.
	const messages = listMessages(db, conversation.id).filter((m) => m.status !== 'partial');
	const { summary: existing, rows: unsummarized } = unsummarizedMessages(
		db,
		conversation.id,
		messages
	);
	if (unsummarized.length <= MIN_KEEP_MESSAGES) return;

	// The prompt is the existing summary plus every unsummarized message,
	// including the keep-window, so that is what has to fit.
	const tokens = unsummarized.map(estimateMessageTokens);
	const existingTokens = existing ? existing.token_estimate : 0;
	if (tokens.reduce((sum, t) => sum + t, 0) + existingTokens < threshold) return;

	// Fold everything except the trailing keep-window into the summary.
	let keepCount = Math.min(keep, unsummarized.length);
	let keptTokens = tokens.slice(-keepCount).reduce((sum, t) => sum + t, 0);
	while (keepCount > MIN_KEEP_MESSAGES && keptTokens > threshold * KEEP_WINDOW_SHARE) {
		keptTokens -= tokens[tokens.length - keepCount];
		keepCount--;
	}
	const foldable = unsummarized.slice(0, unsummarized.length - keepCount);
	if (foldable.length === 0) return;

	const transcript = foldable
		.map((m) => ({ role: m.role, text: messageTranscript(m) }))
		.filter((m) => m.text.trim().length > 0)
		.map((m) => `${m.role.toUpperCase()}: ${m.text}`)
		.join('\n\n');
	if (transcript.trim().length === 0) return;

	const promptParts = [SUMMARY_PROMPT, ''];
	if (existing) {
		promptParts.push(
			`Previous summary (extend it, do not repeat verbatim):\n${existing.summary_text}`,
			'',
			'New messages to fold in:'
		);
	} else {
		promptParts.push('Conversation:');
	}
	promptParts.push(transcript);
	const prompt = promptParts.join('\n');

	const target = summaryTarget(fallbackRef);
	const requestRow = createProxyRequest(db, {
		userId,
		source: 'chat',
		conversationId: conversation.id,
		purpose: 'compaction',
		endpoint: 'generateText',
		requestedModel: target.modelId,
		stream: false
	});
	const startedAt = Date.now();
	try {
		const result = await generateText({
			model: resolveModel(target),
			prompt,
			maxOutputTokens: SUMMARY_TARGET_TOKENS
		});
		const priceRow = findModel(db, target.providerId, target.modelId);
		finalizeProxyRequest(db, requestRow.id, {
			status: 'complete',
			latencyMs: Date.now() - startedAt,
			providerId: target.providerId,
			modelId: target.modelId,
			inputTokens: result.usage?.inputTokens ?? null,
			outputTokens: result.usage?.outputTokens ?? null,
			...cacheTokens(result.usage),
			costUsd: computeUsageCostUsd(priceRow, result.usage)
		});
		const summaryText = result.text.trim();
		if (!summaryText) return;
		const last = foldable[foldable.length - 1];
		createSummary(db, {
			conversationId: conversation.id,
			throughMessageId: last.id,
			throughRowid: last.rowid,
			summaryText,
			tokenEstimate: estimateTokens(summaryText)
		});
		publishServerEvent(userId, { type: 'conversation.compacted', conversationId: conversation.id });
		log.info('Conversation compacted', {
			conversationId: conversation.id,
			foldedMessages: foldable.length,
			summaryTokens: estimateTokens(summaryText)
		});
	} catch (e) {
		finalizeProxyRequest(db, requestRow.id, {
			status: 'failed',
			latencyMs: Date.now() - startedAt,
			providerId: target.providerId,
			modelId: target.modelId,
			error: e instanceof Error ? e.message : String(e)
		});
		log.error('Compaction failed', {
			conversationId: conversation.id,
			error: e instanceof Error ? e.message : String(e)
		});
	}
}
