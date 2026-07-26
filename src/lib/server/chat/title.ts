import { generateText } from 'ai';
import { getDb } from '../db/index.js';
import { setConversationTitle } from '../db/repo/conversations.js';
import { findModel, findRoleModel } from '../db/repo/models.js';
import { createProxyRequest, finalizeProxyRequest } from '../db/repo/proxy-requests.js';
import { publishServerEvent } from '../events/bus.js';
import { resolveModel } from '../llm/registry.js';
import { resolveRefTargets } from '../llm/mapped.js';
import { computeCostUsd } from '../proxy/pricing.js';

function titleTarget(fallback: { providerId: string; modelId: string }): {
	providerId: string;
	modelId: string;
} {
	const db = getDb();
	const role = findRoleModel(db, 'title');
	if (role) {
		return resolveRefTargets({ providerId: role.provider_id, modelId: role.model_id }, db)
			.targets[0];
	}
	return resolveRefTargets(fallback, db).targets[0];
}

export async function generateConversationTitle(
	conversationId: string,
	userId: string,
	fallbackRef: { providerId: string; modelId: string },
	userText: string,
	assistantText: string
): Promise<void> {
	const db = getDb();
	const target = titleTarget(fallbackRef);
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
			model: resolveModel(target),
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
			costUsd: computeCostUsd(
				priceRow?.price_input ?? null,
				priceRow?.price_output ?? null,
				result.usage?.inputTokens,
				result.usage?.outputTokens
			)
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
