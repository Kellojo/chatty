import { callerPrivacy } from '../../privacy/policy.js';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { findRoleModel } from '../../db/repo/models.js';
import { transcribeLogged } from '../../speech/transcriber.js';
import type { CallerContext } from '../types.js';
import { loadConversationAttachment } from './attachments.js';
import { err, text } from './shared.js';

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
				'Transcribe speech in an attached audio or video file to text. ' +
				'Speech-to-text ONLY: there is no text-to-speech tool, so if asked to produce audio, say it is not available instead of searching for one.',
			inputSchema: {
				audio: z
					.string()
					.min(1)
					.describe('Attachment id from the file\'s "[audio … attachment id: <uuid>]" note'),
				language: z
					.string()
					.regex(/^[a-z]{2,3}$/i)
					.optional()
					.describe('ISO-639-1 language, e.g. "en"; improves accuracy and speed'),
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

			const loaded = await loadConversationAttachment(ctx.conversationId, audio, {
				kind: 'audio',
				accepts: isTranscribable
			});
			if (!loaded.ok) return err(loaded.error);
			const { row, bytes } = loaded;

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
					callerPrivacy(ctx),
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
