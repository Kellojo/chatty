import { callerPrivacy } from '../../privacy/policy.js';
import { createHash, randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { generateImage, NoImageGeneratedError, type GenerateImageResult } from 'ai';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { createAttachment } from '../../db/repo/attachments.js';
import { findModel, findRoleModel } from '../../db/repo/models.js';
import { getProvider } from '../../db/repo/providers.js';
import { createProxyRequest, finalizeProxyRequest } from '../../db/repo/proxy-requests.js';
import { computeUsageCostUsd } from '../../proxy/pricing.js';
import { providerSlug, resolveImageModel } from '../../llm/registry.js';
import { ensureAttachmentsDir } from '../../workspaces.js';
import type { CallerContext } from '../types.js';
import { extractAttachmentId, loadConversationAttachment } from './attachments.js';
import { err, text } from './shared.js';

const MAX_N = 4;
const MAX_BASE64_LEN = 20 * 1024 * 1024;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

// Mapped refs (`mapping:` provider IDs) are not supported for images, so the
// ref always names a real provider row.
function imageModelRef(): { providerId: string; modelId: string } | null {
	const row = findRoleModel(getDb(), 'image');
	if (!row || row.provider_id.startsWith('mapping:')) return null;
	return { providerId: row.provider_id, modelId: row.model_id };
}

/** The key the image model reads `providerOptions` and writes `providerMetadata` under. */
function providerOptionsKey(providerId: string): string {
	const provider = getProvider(getDb(), providerId);
	return provider ? providerSlug(provider) : providerId;
}

/**
 * Runs one image model call, logged with the other model calls (Usage → Requests)
 * under the chat or agent run that asked for it.
 */
async function loggedImageCall(
	ctx: CallerContext,
	ref: { providerId: string; modelId: string },
	endpoint: 'images.generate' | 'images.edit',
	run: () => Promise<GenerateImageResult>
): Promise<GenerateImageResult> {
	const db = getDb();
	const log = createProxyRequest(db, {
		userId: ctx.userId,
		source: ctx.agentRunId ? 'agent' : 'chat',
		purpose: 'image',
		endpoint,
		requestedModel: ref.modelId,
		stream: false,
		conversationId: ctx.conversationId ?? null,
		runId: ctx.agentRunId ?? null
	});
	const startedAt = Date.now();
	try {
		const result = await run();
		const usage = {
			inputTokens: result.usage?.inputTokens ?? undefined,
			outputTokens: result.usage?.outputTokens ?? undefined
		};
		finalizeProxyRequest(db, log.id, {
			status: 'complete',
			latencyMs: Date.now() - startedAt,
			providerId: ref.providerId,
			modelId: ref.modelId,
			inputTokens: usage.inputTokens ?? null,
			outputTokens: usage.outputTokens ?? null,
			costUsd: computeUsageCostUsd(findModel(db, ref.providerId, ref.modelId), usage)
		});
		return result;
	} catch (e) {
		finalizeProxyRequest(db, log.id, {
			status: 'failed',
			latencyMs: Date.now() - startedAt,
			providerId: ref.providerId,
			modelId: ref.modelId,
			error: e instanceof Error ? e.message : String(e)
		});
		throw e;
	}
}

const SIZE_RE = /^\d+x\d+$/;
const ASPECT_RE = /^\d+:\d+$/;

export function createImageServer(ctx: CallerContext): McpServer {
	const server = new McpServer({ name: 'ai-chat-image', version: '0.1.0' });

	server.registerTool(
		'generate_image',
		{
			description:
				'Generate images from a text prompt with the configured image model; they are shown in the chat. ' +
				'Pass size or aspectRatio, never both: whichever the model supports (Flux, Imagen and others use aspect ratios).',
			inputSchema: {
				prompt: z.string().min(1),
				size: z.string().regex(SIZE_RE).optional().describe('WxH, e.g. "1024x1024"'),
				aspectRatio: z.string().regex(ASPECT_RE).optional().describe('W:H, e.g. "16:9"'),
				n: z.number().int().min(1).max(MAX_N).optional(),
				quality: z.enum(['standard', 'hd']).optional(),
				style: z.enum(['vivid', 'natural']).optional()
			}
		},
		async ({ prompt, size, aspectRatio, n, quality, style }) => {
			const ref = imageModelRef();
			if (!ref) {
				return err(
					'image generation not configured — ask an admin to pick an image model in Settings → Model Defaults'
				);
			}
			if (!ctx.conversationId) {
				return err('image generation is only available in a conversation context');
			}
			if (size && aspectRatio) {
				return err('pass only one of size or aspectRatio, not both');
			}

			const providerName = providerOptionsKey(ref.providerId);
			const providerOptions: Record<string, Record<string, string>> = {};
			const opts: Record<string, string> = {};
			if (quality) opts.quality = quality;
			if (style) opts.style = style;
			if (Object.keys(opts).length > 0) providerOptions[providerName] = opts;

			const count = Math.min(n ?? 1, MAX_N);
			try {
				const model = resolveImageModel(ref, callerPrivacy(ctx));
				const result = await loggedImageCall(ctx, ref, 'images.generate', () =>
					generateImage({
						model,
						prompt,
						n: count,
						maxImagesPerCall: MAX_N,
						size: size as `${number}x${number}` | undefined,
						aspectRatio: aspectRatio as `${number}:${number}` | undefined,
						...(Object.keys(providerOptions).length > 0 ? { providerOptions } : {})
					})
				);

				const dir = await ensureAttachmentsDir(ctx.conversationId);
				const db = getDb();
				const attachmentIds: string[] = [];
				const filenames: string[] = [];
				for (const image of result.images) {
					const bytes = Buffer.from(image.base64, 'base64');
					const filename = `${randomUUID()}-generated.png`;
					await fsp.writeFile(path.join(dir, filename), bytes);
					const rel = path.join(ctx.conversationId, 'attachments', filename);
					const row = createAttachment(db, {
						kind: 'image',
						path: rel,
						mime: 'image/png',
						sha256: createHash('sha256').update(bytes).digest('hex')
					});
					attachmentIds.push(row.id);
					filenames.push(filename);
				}

				let out = `Generated ${filenames.length} image(s): ${filenames.join(', ')}`;
				const revised = (
					result.providerMetadata as Record<string, { revisedPrompt?: unknown }> | undefined
				)?.[providerName]?.revisedPrompt;
				if (typeof revised === 'string' && revised.trim()) {
					out += `\nRevised prompt: ${revised}`;
				}
				if (result.warnings.length > 0) {
					out += `\nWarnings: ${result.warnings
						.map((w) =>
							w.type === 'unsupported'
								? `unsupported: ${w.feature}${w.details ? ` (${w.details})` : ''}`
								: `${w.type}: ${(w as { message?: string }).message ?? 'unknown'}`
						)
						.join('; ')}`;
				}
				return {
					...text(out),
					structuredContent: { attachmentIds }
				};
			} catch (e) {
				if (NoImageGeneratedError.isInstance(e)) {
					return err(`image generation failed: ${e.message}`);
				}
				return err(`image generation failed: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
	);

	server.registerTool(
		'edit_image',
		{
			description:
				'Edit an image with a text instruction (e.g. "remove the background"); the result is shown in the chat.',
			inputSchema: {
				prompt: z.string().min(1).describe('What to change in the image'),
				image: z
					.string()
					.min(1)
					.describe(
						'Attachment id from the image\'s "[attachment id: <uuid>]" note, or a base64 PNG/JPEG'
					)
			}
		},
		async ({ prompt, image }) => {
			const ref = imageModelRef();
			if (!ref) {
				return err(
					'image generation not configured — ask an admin to pick an image model in Settings → Model Defaults'
				);
			}
			if (!ctx.conversationId) {
				return err('image editing is only available in a conversation context');
			}

			const db = getDb();
			let normalized: string;
			if (extractAttachmentId(image)) {
				const loaded = await loadConversationAttachment(ctx.conversationId, image, {
					kind: 'image',
					accepts: (mime) => mime.startsWith('image/')
				});
				if (!loaded.ok) return err(loaded.error);
				normalized = loaded.bytes.toString('base64');
			} else {
				if (image.length > MAX_BASE64_LEN) {
					return err('image is too large (max 20MB base64)');
				}
				normalized = image.replace(/\s+/g, '');
				if (!BASE64_RE.test(normalized) || normalized.length % 4 !== 0) {
					return err(
						'image must be an attachment ID from this conversation (the UUID at the end of its /api/conversations/.../attachments/<id> URL) or a base64-encoded PNG/JPEG string'
					);
				}
			}

			try {
				const model = resolveImageModel(ref, callerPrivacy(ctx));
				const result = await loggedImageCall(ctx, ref, 'images.edit', () =>
					generateImage({
						model,
						prompt: { images: [normalized], text: prompt },
						n: 1,
						maxImagesPerCall: MAX_N
					})
				);

				const dir = await ensureAttachmentsDir(ctx.conversationId);
				const attachmentIds: string[] = [];
				const filenames: string[] = [];
				for (const img of result.images) {
					const bytes = Buffer.from(img.base64, 'base64');
					const filename = `${randomUUID()}-edited.png`;
					await fsp.writeFile(path.join(dir, filename), bytes);
					const rel = path.join(ctx.conversationId, 'attachments', filename);
					const row = createAttachment(db, {
						kind: 'image',
						path: rel,
						mime: 'image/png',
						sha256: createHash('sha256').update(bytes).digest('hex')
					});
					attachmentIds.push(row.id);
					filenames.push(filename);
				}

				let out = `Edited ${filenames.length} image(s): ${filenames.join(', ')}`;
				if (result.warnings.length > 0) {
					out += `\nWarnings: ${result.warnings
						.map((w) =>
							w.type === 'unsupported'
								? `unsupported: ${w.feature}${w.details ? ` (${w.details})` : ''}`
								: `${w.type}: ${(w as { message?: string }).message ?? 'unknown'}`
						)
						.join('; ')}`;
				}
				return {
					...text(out),
					structuredContent: { attachmentIds }
				};
			} catch (e) {
				if (NoImageGeneratedError.isInstance(e)) {
					return err(`image editing failed: ${e.message}`);
				}
				return err(`image editing failed: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
	);

	return server;
}
