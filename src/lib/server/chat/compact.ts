import { generateText } from 'ai';
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { createSummary, latestSummary } from '../db/repo/conversation-summaries.js';
import type { ConversationRow } from '../db/repo/conversations.js';
import { extractText, listMessages, type MessageRow } from '../db/repo/messages.js';
import { findModel, findRoleModel, type ModelRow } from '../db/repo/models.js';
import { createProxyRequest, finalizeProxyRequest } from '../db/repo/proxy-requests.js';
import { publishServerEvent } from '../events/bus.js';
import { resolveModel } from '../llm/registry.js';
import { resolveRefTargets } from '../llm/mapped.js';
import { createLogger } from '../logger.js';
import { computeCostUsd } from '../proxy/pricing.js';

const log = createLogger('chat-compact');

const CHARS_PER_TOKEN = 4;
const SAFETY_MARGIN = 0.85;
const RESPONSE_RESERVE_TOKENS = 4096;
const MIN_THRESHOLD_TOKENS = 4000;
const SUMMARY_TARGET_TOKENS = 2000;

export function estimateTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function messageText(m: MessageRow): string {
	return extractText(JSON.parse(m.parts) as unknown[]);
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

	const messages = listMessages(db, conversation.id).filter((m) => m.status !== 'partial');
	if (messages.length <= keep) return;

	const existing = latestSummary(db, conversation.id);
	const unsummarized = existing
		? messages.filter((m) => m.rowid > existing.through_rowid)
		: messages;

	// Fold everything except the trailing keep-window into the summary.
	const foldable = unsummarized.slice(0, Math.max(0, unsummarized.length - keep));
	if (foldable.length === 0) return;

	const foldableTokens = foldable.reduce((sum, m) => sum + estimateTokens(messageText(m)), 0);
	const existingTokens = existing ? existing.token_estimate : 0;
	if (foldableTokens + existingTokens < threshold) return;

	const transcript = foldable
		.map((m) => `${m.role.toUpperCase()}: ${messageText(m)}`)
		.filter((line) => line.trim().length > 0)
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
			costUsd: computeCostUsd(
				priceRow?.price_input ?? null,
				priceRow?.price_output ?? null,
				result.usage?.inputTokens,
				result.usage?.outputTokens
			)
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
