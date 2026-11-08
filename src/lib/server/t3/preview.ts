// Relays a coding agent's browser preview from its T3 server.
//
// T3 runs preview tabs in a browser on the coding machine (`preview.list` lists
// a thread's tabs). `/api/preview-stream/ws?threadId&tabId` streams one tab:
// binary messages are JPEG frames, each acknowledged with `{"type":"ack"}`
// before the next is sent; text messages are JSON state (`viewport`, `control`,
// `popup`, …). Viewers with the `preview:operate` scope may send input
// (`mouse`, `key`, `navigate`, …) on the same socket. Close code 4404 means the
// tab is gone, 4503 that the host can't run its browser.
//
// The browser never talks to T3: Chatty holds the socket and the user's page
// receives frames over SSE and posts input back, addressed by a viewer id.

import { randomUUID } from 'node:crypto';
import type { CodingPreviewTab, PreviewStreamEvent } from '$lib/coding-preview.js';
import { decryptSecret } from '../crypto.js';
import type { Db } from '../db/index.js';
import { getCodingConversationForUser } from '../db/repo/coding-conversations.js';
import { getCodingEnvironment } from '../db/repo/coding-environments.js';
import { connectT3, openT3MediaSocket, T3ClientError } from './client.js';
import { CodingTaskError } from './tasks.js';

const STREAM_PATH = '/api/preview-stream/ws';
const TAB_GONE_CODE = 4404;
const HOST_SETUP_CODE = 4503;
const RECONNECT_CODE = 1012;
/** Open preview streams one user may hold at once. */
const MAX_VIEWERS_PER_USER = 4;
const MAX_URL_LENGTH = 4096;
const MAX_TEXT_LENGTH = 10_000;

interface TaskTarget {
	baseUrl: string;
	token: string;
	threadId: string;
}

function resolveTask(db: Db, userId: string, conversationId: string): TaskTarget {
	const coding = getCodingConversationForUser(db, userId, conversationId);
	if (!coding?.environment_id || !coding.thread_id) {
		throw new CodingTaskError(404, 'Coding task not found');
	}
	const env = getCodingEnvironment(db, userId, coding.environment_id);
	if (!env || env.enabled !== 1) throw new CodingTaskError(404, 'Coding environment not found');
	return {
		baseUrl: env.base_url,
		token: decryptSecret(env.token_enc),
		threadId: coding.thread_id
	};
}

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function text(value: unknown): string | null {
	return typeof value === 'string' && value.length > 0 ? value : null;
}

function finite(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

const NAV_STATUS: Record<string, CodingPreviewTab['status']> = {
	Idle: 'idle',
	Loading: 'loading',
	Success: 'ready',
	LoadFailed: 'failed'
};

/** Decodes a `preview.list` result defensively; unusable entries are skipped. */
export function parsePreviewTabs(value: unknown): CodingPreviewTab[] {
	const sessions = record(value)?.sessions;
	if (!Array.isArray(sessions)) return [];
	const tabs: CodingPreviewTab[] = [];
	for (const raw of sessions) {
		const session = record(raw);
		const tabId = text(session?.tabId);
		if (!session || !tabId) continue;
		const nav = record(session.navStatus);
		const status = NAV_STATUS[text(nav?._tag) ?? ''] ?? 'idle';
		tabs.push({
			tabId,
			url: text(nav?.url),
			title: text(nav?.title),
			status,
			error: status === 'failed' ? (text(nav?.description) ?? 'The page failed to load') : null,
			canGoBack: session.canGoBack === true,
			canGoForward: session.canGoForward === true
		});
	}
	return tabs;
}

function toPreviewError(e: unknown): CodingTaskError {
	if (e instanceof CodingTaskError) return e;
	if (e instanceof T3ClientError && e.kind === 'unauthorized') {
		return new CodingTaskError(403, 'The coding machine rejected access to its browser previews');
	}
	if (e instanceof T3ClientError && e.kind === 'remote') {
		return new CodingTaskError(404, 'The browser preview is not available');
	}
	return new CodingTaskError(502, 'Could not reach the coding machine');
}

/** The browser tabs open for a coding task's thread. */
export async function listCodingPreviewTabs(
	db: Db,
	userId: string,
	conversationId: string
): Promise<CodingPreviewTab[]> {
	const task = resolveTask(db, userId, conversationId);
	try {
		const conn = await connectT3(task.baseUrl, task.token);
		try {
			return parsePreviewTabs(await conn.call('preview.list', { threadId: task.threadId }));
		} finally {
			conn.close();
		}
	} catch (e) {
		throw toPreviewError(e);
	}
}

const MOUSE_ACTIONS = new Set(['down', 'up', 'move']);
const MOUSE_BUTTONS = new Set(['none', 'left', 'middle', 'right']);

function modifiers(value: unknown): number {
	const n = finite(value);
	return n !== null && Number.isInteger(n) && n >= 0 && n < 16 ? n : 0;
}

function isWebUrl(value: string): boolean {
	try {
		const { protocol } = new URL(value);
		return protocol === 'http:' || protocol === 'https:';
	} catch {
		return false;
	}
}

/**
 * Keeps only the viewer input T3 understands, field by field, so a page can't
 * smuggle anything else onto the socket. Returns null for anything unknown.
 */
export function sanitizePreviewInput(raw: unknown): Record<string, unknown> | null {
	const m = record(raw);
	if (!m) return null;
	switch (m.type) {
		case 'mouse': {
			const x = finite(m.x);
			const y = finite(m.y);
			if (x === null || y === null || !MOUSE_ACTIONS.has(String(m.action))) return null;
			const button = MOUSE_BUTTONS.has(String(m.button)) ? m.button : 'none';
			return {
				type: 'mouse',
				action: m.action,
				x,
				y,
				button,
				buttons: modifiers(m.buttons),
				clickCount: Math.min(Math.max(Math.round(finite(m.clickCount) ?? 1), 0), 3),
				modifiers: modifiers(m.modifiers)
			};
		}
		case 'wheel': {
			const x = finite(m.x);
			const y = finite(m.y);
			if (x === null || y === null) return null;
			return {
				type: 'wheel',
				x,
				y,
				deltaX: finite(m.deltaX) ?? 0,
				deltaY: finite(m.deltaY) ?? 0,
				modifiers: modifiers(m.modifiers)
			};
		}
		case 'key': {
			const key = typeof m.key === 'string' ? m.key.slice(0, 64) : '';
			const code = typeof m.code === 'string' ? m.code.slice(0, 64) : '';
			if (!key && !code) return null;
			const action = m.action === 'up' ? 'up' : 'down';
			const keyText = typeof m.text === 'string' && m.text.length <= 8 ? m.text : undefined;
			const keyCode = finite(m.keyCode);
			return {
				type: 'key',
				action,
				key,
				code,
				...(keyText ? { text: keyText } : {}),
				...(keyCode !== null ? { keyCode } : {}),
				modifiers: modifiers(m.modifiers)
			};
		}
		case 'text':
			return typeof m.text === 'string' && m.text.length > 0
				? { type: 'text', text: m.text.slice(0, MAX_TEXT_LENGTH) }
				: null;
		case 'navigate':
			return typeof m.url === 'string' && m.url.length <= MAX_URL_LENGTH && isWebUrl(m.url)
				? { type: 'navigate', url: m.url }
				: null;
		case 'history':
			return { type: 'history', delta: (finite(m.delta) ?? 0) < 0 ? -1 : 1 };
		case 'reload':
			return { type: 'reload' };
		case 'takeControl':
		case 'releaseControl':
			return { type: m.type };
		default:
			return null;
	}
}

/** Decodes the JSON state T3 sends next to frames; other kinds are dropped. */
export function parseStreamMessage(data: string): PreviewStreamEvent | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(data);
	} catch {
		return null;
	}
	const m = record(parsed);
	switch (m?.type) {
		case 'viewport': {
			const width = finite(m.width);
			const height = finite(m.height);
			return width && height && width > 0 && height > 0
				? { type: 'viewport', width, height }
				: null;
		}
		case 'control': {
			const controller = m.controller;
			return controller === 'you' ||
				controller === 'another-viewer' ||
				controller === 'agent' ||
				controller === 'unclaimed'
				? { type: 'control', canOperate: m.canOperate === true, controller }
				: null;
		}
		case 'popup': {
			const tabId = text(m.tabId);
			return tabId ? { type: 'popup', tabId } : null;
		}
		default:
			return null;
	}
}

/** What a closed stream means for the viewer. */
export function describeStreamClose(
	code: number,
	reason: string
): Extract<PreviewStreamEvent, { type: 'end' }> {
	if (code === TAB_GONE_CODE) {
		return { type: 'end', reason: 'gone', message: 'This browser tab was closed' };
	}
	if (code === HOST_SETUP_CODE) {
		let command: string | null = null;
		try {
			command = text(record(JSON.parse(reason))?.command);
		} catch {
			// not the JSON T3 sends
		}
		return {
			type: 'end',
			reason: 'unavailable',
			message: command
				? `The coding machine can't start its preview browser. Run \`${command}\` there once.`
				: "The coding machine can't start its preview browser"
		};
	}
	if (code === RECONNECT_CODE) {
		return { type: 'end', reason: 'restart', message: 'The preview restarted' };
	}
	return { type: 'end', reason: 'error', message: 'The preview stream ended' };
}

export interface PreviewViewerHandlers {
	/** A JPEG frame. Call `ack()` on the viewer once it's been passed on. */
	onFrame: (jpeg: Uint8Array) => void;
	onEvent: (event: PreviewStreamEvent) => void;
}

export interface PreviewViewer {
	readonly id: string;
	/** Lets T3 send the next frame. */
	ack(): void;
	close(): void;
}

interface ViewerEntry {
	userId: string;
	conversationId: string;
	send: (message: Record<string, unknown>) => void;
	/** Ends the viewer with `event` and closes its socket. */
	close: (event: Extract<PreviewStreamEvent, { type: 'end' }>) => void;
}

const viewers = new Map<string, ViewerEntry>();

function viewerCount(userId: string): number {
	let count = 0;
	for (const entry of viewers.values()) if (entry.userId === userId) count++;
	return count;
}

/**
 * Attaches to one preview tab. Resolves once the stream is open; the stream's
 * end (for any reason, including `close()`) is reported once as an `end` event.
 */
export async function openPreviewViewer(
	db: Db,
	userId: string,
	conversationId: string,
	tabId: string,
	size: { maxWidth: number; maxHeight: number },
	handlers: PreviewViewerHandlers
): Promise<PreviewViewer> {
	if (viewerCount(userId) >= MAX_VIEWERS_PER_USER) {
		throw new CodingTaskError(429, 'Too many browser previews are open — close one first');
	}
	const task = resolveTask(db, userId, conversationId);
	let ws: WebSocket;
	try {
		ws = await openT3MediaSocket(task.baseUrl, task.token, STREAM_PATH, {
			threadId: task.threadId,
			tabId,
			maxWidth: String(size.maxWidth),
			maxHeight: String(size.maxHeight)
		});
	} catch (e) {
		throw toPreviewError(e);
	}

	const id = randomUUID();
	let ended = false;
	const send = (message: Record<string, unknown>) => {
		if (ws.readyState !== WebSocket.OPEN) return;
		try {
			ws.send(JSON.stringify(message));
		} catch {
			// closing; the close event ends the viewer
		}
	};
	const end = (event: Extract<PreviewStreamEvent, { type: 'end' }>) => {
		if (ended) return;
		ended = true;
		viewers.delete(id);
		handlers.onEvent(event);
	};

	ws.addEventListener('message', (event) => {
		if (ended) return;
		if (event.data instanceof ArrayBuffer) {
			handlers.onFrame(new Uint8Array(event.data));
		} else if (typeof event.data === 'string') {
			const parsed = parseStreamMessage(event.data);
			if (parsed) handlers.onEvent(parsed);
		}
	});
	ws.addEventListener('close', (event) => end(describeStreamClose(event.code, event.reason)));
	ws.addEventListener('error', () =>
		end({ type: 'end', reason: 'error', message: 'Lost the connection to the coding machine' })
	);

	const close = (event: Extract<PreviewStreamEvent, { type: 'end' }>) => {
		end(event);
		try {
			ws.close(1000);
		} catch {
			// already closed
		}
	};
	viewers.set(id, { userId, conversationId, send, close });
	return {
		id,
		ack: () => send({ type: 'ack' }),
		close: () => close({ type: 'end', reason: 'error', message: 'Closed' })
	};
}

/**
 * Ends every open viewer (for shutdown): each one's SSE response gets its
 * `end` event and finishes, so it doesn't hold the HTTP server open.
 */
export function closeAllPreviewViewers(): void {
	for (const entry of [...viewers.values()]) {
		entry.close({ type: 'end', reason: 'restart', message: 'The server is restarting' });
	}
}

/**
 * Forwards input to an open viewer. Returns false when the viewer is gone (or
 * belongs to someone else), so the page can stop sending.
 */
export function sendPreviewInput(
	userId: string,
	conversationId: string,
	viewerId: string,
	messages: unknown[]
): boolean {
	const entry = viewers.get(viewerId);
	if (!entry || entry.userId !== userId || entry.conversationId !== conversationId) return false;
	for (const raw of messages) {
		const message = sanitizePreviewInput(raw);
		if (message) entry.send(message);
	}
	return true;
}
