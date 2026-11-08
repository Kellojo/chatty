// Files a user attaches to a coding task's message, handed to T3 Code the way
// its own web client does it:
// - images T3 accepts inline (png/jpeg/gif/webp) go through
//   `assets.persistChatAttachments` as data URLs, which stores them with the
//   thread and returns `{ type: 'image', id, … }` references;
// - any other file is uploaded: `attachments.createUploadUrl` signs a
//   same-server URL, the bytes are POSTed there, and the message refers to it
//   as `{ type: 'file', id: attachmentId, … }`.
// The references go into `launchThread`'s initial message or `message.dispatch`.

import { readFile } from 'node:fs/promises';
import type { UIMessage } from 'ai';
import { decryptSecret } from '../crypto.js';
import type { Db } from '../db/index.js';
import { getConversationAttachment } from '../db/repo/attachments.js';
import { resolveAttachment } from '../workspaces.js';
import { t3PostBinary, T3ClientError, type T3Connection } from './client.js';
import type { T3EnvironmentRef } from './pool.js';

/** A file read from Chatty's storage, ready to hand to T3. */
export interface CodingUpload {
	name: string;
	mimeType: string;
	bytes: Uint8Array;
}

/** What T3 puts in a message's `attachments`. */
export interface T3AttachmentRef {
	type: 'image' | 'file';
	id: string;
	name: string;
	mimeType: string;
	sizeBytes: number;
}

/** Image types T3 takes inline (its `Vy` list); other images go up as files. */
const INLINE_IMAGE_TYPES = new Set(['image/gif', 'image/jpeg', 'image/png', 'image/webp']);
/** T3's limits: 10 MiB per image, 50 MiB per file, 80 MiB of images and 100 attachments per message. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_IMAGE_TOTAL_BYTES = 80 * 1024 * 1024;
export const MAX_ATTACHMENTS = 100;

/** Message text T3's client sends when a message is only attachments. */
export const ATTACHMENTS_ONLY_TEXT =
	'[User attached one or more files without additional text. Respond using the conversation context and the attached files.]';

export class CodingAttachmentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CodingAttachmentError';
	}
}

export const isInlineImage = (mimeType: string) => INLINE_IMAGE_TYPES.has(mimeType.toLowerCase());

const attachmentPrefix = (conversationId: string) =>
	`/api/conversations/${conversationId}/attachments/`;

function decodeDataUrl(url: string): { mimeType: string; bytes: Uint8Array } | null {
	const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(url);
	if (!match) return null;
	const bytes = match[2]
		? Buffer.from(match[3], 'base64')
		: Buffer.from(decodeURIComponent(match[3]), 'utf8');
	return { mimeType: match[1] || 'application/octet-stream', bytes };
}

const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max) : s);

/**
 * Reads a message's file parts (this conversation's uploads or inline data
 * URLs) and checks them against T3's limits.
 */
export async function readCodingAttachments(
	db: Db,
	conversationId: string,
	parts: UIMessage['parts']
): Promise<CodingUpload[]> {
	const files = parts.filter((p) => p.type === 'file');
	if (files.length > MAX_ATTACHMENTS) {
		throw new CodingAttachmentError(`Attach at most ${MAX_ATTACHMENTS} files per message`);
	}
	const uploads: CodingUpload[] = [];
	for (const part of files) {
		let mimeType = part.mediaType || 'application/octet-stream';
		let bytes: Uint8Array;
		if (part.url.startsWith('data:')) {
			const decoded = decodeDataUrl(part.url);
			if (!decoded) throw new CodingAttachmentError('An attachment could not be read');
			mimeType = part.mediaType || decoded.mimeType;
			bytes = decoded.bytes;
		} else {
			const prefix = attachmentPrefix(conversationId);
			const id = part.url.startsWith(prefix) ? part.url.slice(prefix.length).split(/[?#]/)[0] : '';
			const row = id ? getConversationAttachment(db, conversationId, id) : undefined;
			if (!row) throw new CodingAttachmentError('An attachment is no longer available');
			mimeType = row.mime || mimeType;
			try {
				bytes = await readFile(await resolveAttachment(row.path));
			} catch {
				throw new CodingAttachmentError(`Attachment ${part.filename ?? id} is no longer available`);
			}
		}
		const name = clip(part.filename?.trim() || 'attachment', 255);
		const limit = isInlineImage(mimeType) ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
		if (bytes.byteLength === 0) throw new CodingAttachmentError(`${name} is empty`);
		if (bytes.byteLength > limit) {
			throw new CodingAttachmentError(
				`${name} is too large for the coding agent (max ${limit / 1024 / 1024} MB)`
			);
		}
		uploads.push({ name, mimeType: clip(mimeType.toLowerCase(), 100), bytes });
	}
	const imageBytes = uploads
		.filter((u) => isInlineImage(u.mimeType))
		.reduce((sum, u) => sum + u.bytes.byteLength, 0);
	if (imageBytes > MAX_IMAGE_TOTAL_BYTES) {
		throw new CodingAttachmentError('Images can total up to 80 MB per message');
	}
	return uploads;
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null =>
	v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null;

/** A reference T3 returned, or null if it isn't one. */
function parseRef(value: unknown): T3AttachmentRef | null {
	const r = rec(value);
	if (!r || typeof r.id !== 'string' || !r.id) return null;
	if (r.type !== 'image' && r.type !== 'file') return null;
	return {
		type: r.type,
		id: r.id,
		name: typeof r.name === 'string' ? r.name : '',
		mimeType: typeof r.mimeType === 'string' ? r.mimeType : '',
		sizeBytes: typeof r.sizeBytes === 'number' ? r.sizeBytes : 0
	};
}

/**
 * Stores `files` on the T3 server for message `messageId` of `threadId` (the
 * thread may not exist yet; T3's client persists before launching too) and
 * returns the references to send with the message, in the same order.
 */
export async function uploadCodingAttachments(
	conn: T3Connection,
	env: Pick<T3EnvironmentRef, 'base_url' | 'token_enc'>,
	input: { threadId: string; messageId: string; files: readonly CodingUpload[] }
): Promise<T3AttachmentRef[]> {
	const refs: (T3AttachmentRef | null)[] = input.files.map(() => null);

	const images = input.files
		.map((file, index) => ({ file, index }))
		.filter(({ file }) => isInlineImage(file.mimeType));
	if (images.length > 0) {
		const result = rec(
			await conn.call('assets.persistChatAttachments', {
				threadId: input.threadId,
				messageId: input.messageId,
				attachments: images.map(({ file }) => ({
					type: 'image',
					name: file.name,
					mimeType: file.mimeType,
					sizeBytes: file.bytes.byteLength,
					dataUrl: `data:${file.mimeType};base64,${Buffer.from(file.bytes).toString('base64')}`
				}))
			})
		);
		const persisted = Array.isArray(result?.attachments) ? result.attachments : [];
		images.forEach(({ index }, i) => (refs[index] = parseRef(persisted[i])));
	}

	const token = decryptSecret(env.token_enc);
	for (const [index, file] of input.files.entries()) {
		if (isInlineImage(file.mimeType)) continue;
		const signed = rec(
			await conn.call('attachments.createUploadUrl', {
				type: 'file',
				name: file.name,
				mimeType: file.mimeType,
				sizeBytes: file.bytes.byteLength
			})
		);
		const attachmentId = typeof signed?.attachmentId === 'string' ? signed.attachmentId : '';
		const relativeUrl = typeof signed?.relativeUrl === 'string' ? signed.relativeUrl : '';
		// Signed upload URLs are same-server paths; refuse anything else.
		if (!attachmentId || !relativeUrl.startsWith('/') || relativeUrl.startsWith('//')) {
			throw new T3ClientError('The coding environment did not return an upload URL', 'protocol');
		}
		await t3PostBinary(env.base_url, token, relativeUrl, file.mimeType, file.bytes);
		refs[index] = {
			type: 'file',
			id: attachmentId,
			name: file.name,
			mimeType: file.mimeType,
			sizeBytes: file.bytes.byteLength
		};
	}

	if (refs.some((r) => r === null)) {
		throw new T3ClientError('The coding environment did not store every attachment', 'protocol');
	}
	return refs as T3AttachmentRef[];
}
