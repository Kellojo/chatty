import fsp from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { listAttachmentsByConversation } from '../../db/repo/attachments.js';
import { findRoleModel } from '../../db/repo/models.js';
import { transcribeLogged } from '../../speech/transcriber.js';
import { resolveAttachment } from '../../workspaces.js';
import type { CallerContext } from '../types.js';
import { err, text } from './shared.js';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Audio, or video whose soundtrack speech-to-text models read (mp4, webm…). */
export function isTranscribable(mime: string): boolean {
	return mime.startsWith('audio/') || mime.startsWith('video/');
}

/** The name a file was uploaded with: stored as `<uuid>-<name>`. */
function uploadedName(storedPath: string): string {
	return path.basename(storedPath).replace(/^[0-9a-f-]{36}-/i, '');
}

export function createSpeechServer(ctx: CallerContext): McpServer {
	const server = new McpServer({ name: 'ai-chat-speech', version: '0.1.0' });

	server.registerTool(
		'transcribe_audio',
		{
			description:
				'Transcribe speech in an audio (or video) file attached to this conversation into text, ' +
				'using the configured speech-to-text model. Pass the attachment ID shown next to the file ' +
				'(in a "[audio … attachment id: <uuid>]" note).',
			inputSchema: {
				audio: z.string().min(1).describe('Attachment ID of an audio file in this conversation'),
				language: z
					.string()
					.regex(/^[a-z]{2,3}$/i)
					.optional()
					.describe('ISO-639-1 language of the speech, e.g. "en"; improves accuracy and speed'),
				prompt: z
					.string()
					.max(1000)
					.optional()
					.describe('Names, terms or earlier context to guide spelling')
			}
		},
		async ({ audio, language, prompt }) => {
			const db = getDb();
			const role = findRoleModel(db, 'speech-to-text');
			if (!role) {
				return err(
					'speech to text is not configured — ask an admin to pick a Speech to text model in Settings → Defaults'
				);
			}
			if (!ctx.conversationId) {
				return err('transcription is only available in a conversation context');
			}

			const available = listAttachmentsByConversation(db, ctx.conversationId).filter((a) =>
				isTranscribable(a.mime)
			);
			const attachmentId = audio.match(UUID_RE)?.[0];
			const row = attachmentId ? available.find((a) => a.id === attachmentId) : undefined;
			if (!row) {
				const hint =
					available.length > 0
						? `audio attachment IDs in this conversation: ${available.map((a) => a.id).join(', ')}`
						: 'there are no audio attachments in this conversation';
				return err(`no audio attachment found for "${audio}" — ${hint}`);
			}

			let bytes: Buffer;
			try {
				bytes = await fsp.readFile(await resolveAttachment(row.path));
			} catch {
				return err(`could not read attachment ${row.id} from disk`);
			}

			try {
				const transcript = await transcribeLogged(
					bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
					{ providerId: role.provider_id, modelId: role.model_id },
					{
						userId: ctx.userId,
						source: ctx.agentRunId ? 'agent' : 'chat',
						conversationId: ctx.conversationId,
						runId: ctx.agentRunId ?? null
					},
					{ fileName: uploadedName(row.path), mimeType: row.mime, language, prompt }
				);
				const trimmed = transcript.trim();
				return text(trimmed ? trimmed : '(no speech was recognized in this audio)');
			} catch (e) {
				return err(`transcription failed: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
	);

	return server;
}
