// Serves images a coding agent saved on its T3 machine, so replies that embed
// them by local path render in Chatty. T3 signs a short-lived URL for the file
// (assets.createUrl, needs the token's `filesystem:read` scope) and Chatty relays the
// bytes; the browser never talks to T3 directly.

import { isLocalImagePath } from '$lib/coding-assets.js';
import { decryptSecret } from '../crypto.js';
import type { Db } from '../db/index.js';
import { getCodingConversationForUser } from '../db/repo/coding-conversations.js';
import { getCodingEnvironment } from '../db/repo/coding-environments.js';
import { connectT3, t3FetchBinary, T3ClientError, type T3Connection } from './client.js';
import { CodingTaskError } from './tasks.js';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export interface CodingAsset {
	contentType: string;
	bytes: Uint8Array;
}

/** Characters that would make a match part of a longer path. */
const PATH_CHAR_BEFORE = /[\p{L}\p{N}_.~\-/\\:]/u;
const PATH_CHAR_AFTER = /[\p{L}\p{N}_\-/\\]/u;

/** Whether `path` occurs in `text` as a whole path, not inside a longer one. */
export function containsPath(text: string, path: string): boolean {
	for (let i = text.indexOf(path); i !== -1; i = text.indexOf(path, i + 1)) {
		const before = text[i - 1];
		const after = text[i + path.length];
		if (before !== undefined && PATH_CHAR_BEFORE.test(before)) continue;
		if (after !== undefined && PATH_CHAR_AFTER.test(after)) continue;
		// A trailing "." ends a sentence, but ".png" etc. would extend the path.
		const next = text[i + path.length + 1];
		if (after === '.' && next !== undefined && /[\p{L}\p{N}]/u.test(next)) continue;
		return true;
	}
	return false;
}

function someString(value: unknown, test: (s: string) => boolean): boolean {
	if (typeof value === 'string') return test(value);
	if (Array.isArray(value)) return value.some((v) => someString(v, test));
	if (value && typeof value === 'object') {
		return Object.values(value).some((v) => someString(v, test));
	}
	return false;
}

/**
 * Only paths the coding agent itself put in the conversation are served, so a
 * chat can't be used to read arbitrary files off the coding machine.
 */
function isReferenced(db: Db, conversationId: string, path: string): boolean {
	// Message parts are stored as JSON, where backslashes are escaped; the SQL
	// substring match only prefilters, the exact check runs on decoded strings.
	const needle = JSON.stringify(path).slice(1, -1);
	const rows = db
		.prepare(
			`SELECT parts FROM messages
			 WHERE conversation_id = ? AND role = 'assistant' AND instr(parts, ?) > 0`
		)
		.all(conversationId, needle) as { parts: string }[];
	return rows.some(({ parts }) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(parts);
		} catch {
			return false;
		}
		return someString(parsed, (s) => containsPath(s, path));
	});
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
	let conn: T3Connection;
	try {
		conn = await connectT3(env.base_url, token);
	} catch (e) {
		throw toAssetError(e);
	}
	try {
		const result = await conn.call<{ relativeUrl?: unknown }>('assets.createUrl', {
			resource: { _tag: 'media-file', threadId: coding.thread_id, path }
		});
		relativeUrl = typeof result?.relativeUrl === 'string' ? result.relativeUrl : null;
	} catch (e) {
		if (e instanceof T3ClientError && e.kind === 'unauthorized') throw toAssetError(e);
		throw new CodingTaskError(404, 'Image not available on the coding machine');
	} finally {
		conn.close();
	}
	// Signed URLs are always same-server paths; refuse anything else.
	if (!relativeUrl || !relativeUrl.startsWith('/api/assets/')) {
		throw new CodingTaskError(404, 'Image not available on the coding machine');
	}

	let file: Awaited<ReturnType<typeof t3FetchBinary>>;
	try {
		file = await t3FetchBinary(env.base_url, token, relativeUrl, MAX_IMAGE_BYTES);
	} catch (e) {
		throw toAssetError(e);
	}
	if (!file) throw new CodingTaskError(404, 'Image not available on the coding machine');
	if (!file.contentType.startsWith('image/') || file.contentType.includes('svg')) {
		throw new CodingTaskError(415, 'Not an image');
	}
	return file;
}

/** Maps a failure talking to T3 to the response the image route sends. */
function toAssetError(e: unknown): CodingTaskError {
	if (e instanceof T3ClientError && e.kind === 'unauthorized') {
		return new CodingTaskError(
			403,
			'Re-pair this coding environment to show images from it (it needs file read access)'
		);
	}
	// T3 answered but refused (too large, server error): treat as unavailable.
	if (e instanceof T3ClientError && e.kind === 'remote') {
		return new CodingTaskError(404, 'Image not available on the coding machine');
	}
	return new CodingTaskError(502, 'Could not reach the coding machine');
}
