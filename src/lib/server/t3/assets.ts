// Serves images a coding agent saved on its T3 machine, so replies that embed
// them by local path render in Chatty. T3 signs a short-lived URL for the file
// (assets.createUrl, needs the token's `workspace` scope) and Chatty relays the
// bytes; the browser never talks to T3 directly.

import { isLocalImagePath } from '$lib/coding-assets.js';
import { decryptSecret } from '../crypto.js';
import type { Db } from '../db/index.js';
import { getCodingConversationForUser } from '../db/repo/coding-conversations.js';
import { getCodingEnvironment } from '../db/repo/coding-environments.js';
import { connectT3, t3FetchBinary, T3ClientError } from './client.js';
import { CodingTaskError } from './tasks.js';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export interface CodingAsset {
	contentType: string;
	bytes: Uint8Array;
}

/**
 * Only paths that already appear in the conversation are served, so a chat
 * can't be used to read arbitrary files off the coding machine.
 */
function isReferenced(db: Db, conversationId: string, path: string): boolean {
	// Message parts are stored as JSON, where backslashes are escaped.
	const needle = JSON.stringify(path).slice(1, -1);
	const row = db
		.prepare('SELECT 1 FROM messages WHERE conversation_id = ? AND instr(parts, ?) > 0 LIMIT 1')
		.get(conversationId, needle);
	return row !== undefined;
}

export async function fetchCodingImage(
	db: Db,
	userId: string,
	conversationId: string,
	path: string
): Promise<CodingAsset> {
	if (!isLocalImagePath(path)) throw new CodingTaskError(400, 'Not a local image path');
	const coding = getCodingConversationForUser(db, userId, conversationId);
	if (!coding?.environment_id || !coding.thread_id) {
		throw new CodingTaskError(404, 'Coding task not found');
	}
	if (!isReferenced(db, conversationId, path)) throw new CodingTaskError(404, 'Image not found');
	const env = getCodingEnvironment(db, userId, coding.environment_id);
	if (!env || env.enabled !== 1) throw new CodingTaskError(404, 'Coding environment not found');

	const token = decryptSecret(env.token_enc);
	let relativeUrl: string | null;
	const conn = await connectT3(env.base_url, token);
	try {
		const result = await conn.call<{ relativeUrl?: unknown }>('assets.createUrl', {
			resource: { _tag: 'media-file', threadId: coding.thread_id, path }
		});
		relativeUrl = typeof result?.relativeUrl === 'string' ? result.relativeUrl : null;
	} catch (e) {
		if (e instanceof T3ClientError && e.kind === 'unauthorized') {
			throw new CodingTaskError(
				403,
				'Re-pair this coding environment to show images from it (it needs workspace access)'
			);
		}
		throw new CodingTaskError(404, 'Image not available on the coding machine');
	} finally {
		conn.close();
	}
	// Signed URLs are always same-server paths; refuse anything else.
	if (!relativeUrl || !relativeUrl.startsWith('/api/assets/')) {
		throw new CodingTaskError(404, 'Image not available on the coding machine');
	}

	const file = await t3FetchBinary(env.base_url, token, relativeUrl, MAX_IMAGE_BYTES);
	if (!file) throw new CodingTaskError(404, 'Image not available on the coding machine');
	if (!file.contentType.startsWith('image/') || file.contentType.includes('svg')) {
		throw new CodingTaskError(415, 'Not an image');
	}
	return file;
}
