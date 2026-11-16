import { backgroundTarget, privatePlaceholderTitle } from '../privacy/background.js';
import type { Privacy } from '../privacy/policy.js';
import { generateText } from 'ai';
import { getDb } from '../db/index.js';
import { setConversationTitle } from '../db/repo/conversations.js';
import { findModel } from '../db/repo/models.js';
import { createProxyRequest, finalizeProxyRequest } from '../db/repo/proxy-requests.js';
import { publishServerEvent } from '../events/bus.js';
import { resolveModel } from '../llm/registry.js';
import { cacheTokens, computeUsageCostUsd } from '../proxy/pricing.js';

export async function generateConversationTitle(
	conversationId: string,
	userId: string,
	fallbackRef: { providerId: string; modelId: string },
	userText: string,
	assistantText: string,
	privacy: Privacy
): Promise<void> {
	const db = getDb();
	// The title role, else the chat's model; a private chat only uses a trusted one.
	const target = backgroundTarget(db, 'title', fallbackRef, privacy);
	if (!target) {
		setConversationTitle(db, conversationId, privatePlaceholderTitle());
		publishServerEvent(userId, { type: 'conversation.updated', conversationId });
		return;
	}
	const prompt = [
		'Write a short conversation title (3-6 words, plain text, no quotes, no trailing punctuation) for this exchange.',
		'',
		`User: ${userText.slice(0, 500)}`,
		`Assistant: ${assistantText.slice(0, 500)}`
	].join('\n');
	const startedAt = Date.now();
	const requestRow = createProxyRequest(db, {
		userId,
		source: 'chat',
		conversationId,
		purpose: 'title',
		endpoint: 'generateText',
		requestedModel: target.modelId,
		stream: false
	});
	try {
		const result = await generateText({
			model: resolveModel(target, privacy),
			prompt,
			maxOutputTokens: 30
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
		const title = result.text
			.trim()
			.replace(/^["']|["']$/g, '')
			.slice(0, 80);
		if (title) {
			setConversationTitle(db, conversationId, title);
			publishServerEvent(userId, { type: 'conversation.updated', conversationId });
		}
	} catch (e) {
		finalizeProxyRequest(db, requestRow.id, {
			status: 'failed',
			latencyMs: Date.now() - startedAt,
			providerId: target.providerId,
			modelId: target.modelId,
			error: e instanceof Error ? e.message : String(e)
		});
		throw e;
	}
}
