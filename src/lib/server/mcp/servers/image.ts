import { createHash, randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { generateImage, NoImageGeneratedError } from 'ai';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { createAttachment, listAttachmentsByConversation } from '../../db/repo/attachments.js';
import { findRoleModel } from '../../db/repo/models.js';
import { resolveImageModel } from '../../llm/registry.js';
import { ensureAttachmentsDir, resolveAttachment } from '../../workspaces.js';
import type { CallerContext } from '../types.js';
import { err, text } from './shared.js';

const MAX_N = 4;
const MAX_BASE64_LEN = 20 * 1024 * 1024;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

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

	server.registerTool(
		'edit_image',
		{
			description:
				'Edit an existing image with a text instruction (e.g. "remove the background", "make it more vibrant"). ' +
				'For the source image, pass the attachment ID shown next to an image in the conversation ' +
				'(in a "[attachment id: <uuid>]" note) or a base64-encoded PNG/JPEG string. ' +
				'The edited image is saved as an attachment and shown inline in the chat.',
			inputSchema: {
				prompt: z.string().min(1).describe('What to change in the image'),
				image: z
					.string()
					.min(1)
					.describe(
						'Attachment ID of an image in this conversation, or a base64-encoded PNG/JPEG string'
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
			const uuidMatch = image.match(UUID_RE);
			let normalized: string;
			if (uuidMatch) {
				const attachmentId = uuidMatch[0];
				const available = listAttachmentsByConversation(db, ctx.conversationId).filter((a) =>
					a.mime.startsWith('image/')
				);
				const row = available.find((a) => a.id === attachmentId);
				if (!row) {
					const hint =
						available.length > 0
							? `available image attachment IDs in this conversation: ${available.map((a) => a.id).join(', ')}`
							: 'there are no image attachments in this conversation';
					return err(`no image attachment found with id ${attachmentId} — ${hint}`);
				}
				try {
					const bytes = await fsp.readFile(resolveAttachment(row.path));
					normalized = bytes.toString('base64');
				} catch {
					return err(`could not read attachment ${attachmentId} from disk`);
				}
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
				const model = resolveImageModel(ref);
				const result = await generateImage({
					model,
					prompt: { images: [normalized], text: prompt },
					n: 1,
					maxImagesPerCall: MAX_N
				});

				const dir = ensureAttachmentsDir(ctx.conversationId);
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
