import { createHash, randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { generateImage, NoImageGeneratedError } from 'ai';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { createAttachment } from '../../db/repo/attachments.js';
import { findRoleModel } from '../../db/repo/models.js';
import { resolveImageModel } from '../../llm/registry.js';
import { ensureAttachmentsDir } from '../../workspaces.js';
import type { CallerContext } from '../types.js';
import { err, text } from './shared.js';

const MAX_N = 4;

function imageModelRef(): { providerId: string; modelId: string } | null {
	const row = findRoleModel(getDb(), 'image');
	if (!row || row.provider_id.startsWith('mapping:')) return null;
	return { providerId: row.provider_id, modelId: row.model_id };
}

const SIZE_RE = /^\d+x\d+$/;
const ASPECT_RE = /^\d+:\d+$/;

export function createImageServer(ctx: CallerContext): McpServer {
	const server = new McpServer({ name: 'ai-chat-image', version: '0.1.0' });

	server.registerTool(
		'generate_image',
		{
			description:
				'Generate one or more images from a text prompt using the configured image model. ' +
				'Pass either size (WxH, e.g. "1024x1024") or aspectRatio (W:H, e.g. "16:9"), never both — ' +
				'use the one the model supports (many providers, e.g. Flux/Imagen, use aspect ratios). ' +
				'Generated images are saved as attachments and shown inline in the chat.',
			inputSchema: {
				prompt: z.string().min(1),
				size: z
					.string()
					.regex(SIZE_RE)
					.optional()
					.describe('"{width}x{height}", e.g. "1024x1024" — mutually exclusive with aspectRatio'),
				aspectRatio: z
					.string()
					.regex(ASPECT_RE)
					.optional()
					.describe('"{w}:{h}", e.g. "16:9" — mutually exclusive with size'),
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

			const providerName = ref.providerId.toLowerCase().replace(/[^a-z0-9]+/g, '-');
			const providerOptions: Record<string, Record<string, string>> = {};
			const opts: Record<string, string> = {};
			if (quality) opts.quality = quality;
			if (style) opts.style = style;
			if (Object.keys(opts).length > 0) providerOptions[providerName] = opts;

			const count = Math.min(n ?? 1, MAX_N);
			try {
				const model = resolveImageModel(ref);
				const result = await generateImage({
					model,
					prompt,
					n: count,
					maxImagesPerCall: MAX_N,
					size: size as `${number}x${number}` | undefined,
					aspectRatio: aspectRatio as `${number}:${number}` | undefined,
					...(Object.keys(providerOptions).length > 0 ? { providerOptions } : {})
				});

				const dir = ensureAttachmentsDir(ctx.conversationId);
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

	return server;
}
