// Minimal, read-only client for a remote T3 Code server.
//
// Wire protocol (T3 Code, orchestration protocol 2):
// - `GET /.well-known/t3/environment` describes the server (unauthenticated).
// - `POST /api/auth/websocket-ticket` with `Authorization: Bearer <token>` mints a
//   short-lived ticket; the socket at `/ws?orchestrationProtocol=2&wsTicket=…`
//   speaks Effect RPC with JSON serialization: one JSON message per frame.
//
// Only one-shot RPCs are used here (no streams), so no stream Acks are needed.
// T3 Code moves fast; everything decoded from it is treated as untrusted and
// parsed defensively (see ./usage.ts).

import net from 'node:net';
import { isLinkLocalOrReserved, linkLocalGuardedAgent } from '../net/safeFetch.js';

export const ORCHESTRATION_PROTOCOL_VERSION = 2;

const HTTP_TIMEOUT_MS = 10_000;
/** Binary downloads (images up to tens of MB) get longer than JSON calls. */
const BINARY_TIMEOUT_MS = 60_000;
const CONNECT_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 60_000;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_BODY_BYTES = 16 * 1024 * 1024;

export class T3ClientError extends Error {
	constructor(
		message: string,
		readonly kind: 'unreachable' | 'unauthorized' | 'incompatible' | 'protocol' | 'remote'
	) {
		super(message);
		this.name = 'T3ClientError';
	}
}

export interface EnvironmentDescriptor {
	environmentId: string | null;
	label: string | null;
	serverVersion: string | null;
	orchestrationProtocolVersion: number;
}

function joinUrl(baseUrl: string, path: string): string {
	return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

function str(value: unknown): string | null {
	return typeof value === 'string' && value.length > 0 ? value : null;
}

async function fetchWithTimeout(
	url: string,
	init: RequestInit = {},
	timeoutMs = HTTP_TIMEOUT_MS
): Promise<Response> {
	const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
	// The URL is user-configured. T3 servers legitimately live on loopback/LAN/
	// tailnet addresses, but never on link-local (cloud metadata) ranges.
	if (net.isIP(host) && isLinkLocalOrReserved(host)) {
		throw new T3ClientError('Server unreachable', 'unreachable');
	}
	try {
		return await fetch(url, {
			...init,
			redirect: 'error',
			signal: AbortSignal.timeout(timeoutMs),
			// undici-specific option honoured by Node's built-in fetch.
			dispatcher: linkLocalGuardedAgent
		} as RequestInit);
	} catch (e) {
		const reason = e instanceof Error && e.name === 'TimeoutError' ? 'timed out' : 'unreachable';
		throw new T3ClientError(`Server ${reason}`, 'unreachable');
	}
}

/**
 * Reads a whole body, refusing (and cancelling) bodies over `maxBytes`. A
 * timeout or reset mid-body surfaces as an `unreachable` {@link T3ClientError}.
 */
async function readBody(res: Response, maxBytes: number, tooLarge: string): Promise<Buffer> {
	const declared = Number(res.headers.get('content-length'));
	if (declared > maxBytes) {
		await res.body?.cancel().catch(() => {});
		throw new T3ClientError(tooLarge, 'remote');
	}
	if (!res.body) return Buffer.alloc(0);
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for await (const chunk of res.body) {
			size += chunk.byteLength;
			if (size > maxBytes) {
				await res.body.cancel().catch(() => {});
				throw new T3ClientError(tooLarge, 'remote');
			}
			chunks.push(chunk);
		}
	} catch (e) {
		if (e instanceof T3ClientError) throw e;
		const reason = e instanceof Error && e.name === 'TimeoutError' ? 'timed out' : 'failed';
		throw new T3ClientError(`Reading the response ${reason}`, 'unreachable');
	}
	return Buffer.concat(chunks);
}

/** Parses a JSON body; anything else (e.g. a proxy's HTML page) is `incompatible`. */
async function readJson(res: Response): Promise<unknown> {
	if (!res.body) return null;
	const text = (await readBody(res, MAX_BODY_BYTES, 'Response too large')).toString('utf8');
	try {
		return JSON.parse(text);
	} catch {
		throw new T3ClientError(
			'Unexpected response (not JSON) — is this URL a T3 Code server?',
			'incompatible'
		);
	}
}

export async function fetchEnvironmentDescriptor(baseUrl: string): Promise<EnvironmentDescriptor> {
	const res = await fetchWithTimeout(joinUrl(baseUrl, '/.well-known/t3/environment'), {
		headers: { accept: 'application/json' }
	});
	if (!res.ok) {
		throw new T3ClientError(
			`Not a T3 Code server (environment descriptor returned ${res.status})`,
			'incompatible'
		);
	}
	const body = (await readJson(res).catch(() => null)) as Record<string, unknown> | null;
	if (!body || typeof body !== 'object') {
		throw new T3ClientError(
			'Not a T3 Code server (invalid environment descriptor)',
			'incompatible'
		);
	}
	const protocol = body.orchestrationProtocolVersion;
	return {
		environmentId: str(body.environmentId),
		label: str(body.label),
		serverVersion: str(body.serverVersion),
		// Servers that predate the field speak protocol 1.
		orchestrationProtocolVersion: typeof protocol === 'number' ? protocol : 1
	};
}

/** Scopes Chatty asks for: orchestration (read + start/steer coding tasks), usage diagnostics and cloning repositories. */
export const CHATTY_TOKEN_SCOPES = [
	'orchestration:read',
	'orchestration:operate',
	'diagnostics:read',
	'source-control:write',
	// Lets Chatty mint signed URLs for images the agent saved on the T3 machine
	// (assets.createUrl). T3 only grants that under its broader workspace scope.
	'workspace'
] as const;

/**
 * Exchanges a one-time pairing token (from a `…/pair#token=…` link) for a
 * bearer access token limited to {@link CHATTY_TOKEN_SCOPES}.
 */
export async function exchangePairingToken(baseUrl: string, pairingToken: string): Promise<string> {
	const res = await fetchWithTimeout(joinUrl(baseUrl, '/oauth/token'), {
		method: 'POST',
		headers: { accept: 'application/json' },
		body: new URLSearchParams({
			grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
			subject_token: pairingToken,
			subject_token_type: 'urn:t3:params:oauth:token-type:environment-bootstrap',
			requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
			scope: CHATTY_TOKEN_SCOPES.join(' '),
			client_label: 'Chatty',
			client_device_type: 'bot'
		})
	});
	if (res.status === 400 || res.status === 401 || res.status === 403) {
		throw new T3ClientError(
			'Pairing link was rejected — it may have expired or already been used',
			'unauthorized'
		);
	}
	if (!res.ok) throw new T3ClientError(`Pairing failed (${res.status})`, 'remote');
	const body = (await readJson(res).catch(() => null)) as { access_token?: unknown } | null;
	const token = str(body?.access_token);
	if (!token) throw new T3ClientError('Pairing response was malformed', 'protocol');
	return token;
}

async function issueWebSocketTicket(baseUrl: string, token: string): Promise<string> {
	const res = await fetchWithTimeout(joinUrl(baseUrl, '/api/auth/websocket-ticket'), {
		method: 'POST',
		headers: { authorization: `Bearer ${token}`, accept: 'application/json' }
	});
	if (res.status === 401 || res.status === 403) {
		throw new T3ClientError('Access token was rejected (expired or revoked?)', 'unauthorized');
	}
	if (!res.ok) throw new T3ClientError(`Ticket request failed (${res.status})`, 'remote');
	const body = (await readJson(res).catch(() => null)) as { ticket?: unknown } | null;
	const ticket = str(body?.ticket);
	if (!ticket) throw new T3ClientError('Ticket response was malformed', 'protocol');
	return ticket;
}

type Pending = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

/** Turns an encoded Effect `Exit` failure cause into a readable message. */
export function describeFailureCause(cause: unknown): { message: string; unauthorized: boolean } {
	const reasons = Array.isArray(cause) ? cause : [];
	for (const reason of reasons) {
		if (!reason || typeof reason !== 'object') continue;
		const r = reason as Record<string, unknown>;
		if (r._tag === 'Fail') {
			const err = (r.error ?? {}) as Record<string, unknown>;
			const tag = str(err._tag) ?? 'Error';
			if (tag === 'EnvironmentAuthorizationError') {
				const scope = str(err.requiredPermission) ?? str(err.requiredScope);
				return {
					message: scope ? `Token is missing the "${scope}" scope` : 'Token lacks permission',
					unauthorized: true
				};
			}
			return { message: str(err.message) ?? str(err.detail) ?? tag, unauthorized: false };
		}
		if (r._tag === 'Die') {
			const defect = r.defect;
			const text =
				typeof defect === 'string' ? defect : str((defect as { message?: unknown })?.message);
			return {
				message: text ? `Server error: ${text.slice(0, 300)}` : 'Server error',
				unauthorized: false
			};
		}
		if (r._tag === 'Interrupt') return { message: 'Request was interrupted', unauthorized: false };
	}
	return { message: 'Request failed', unauthorized: false };
}

type StreamHandlers = {
	onValue: (value: unknown) => void;
	onEnd: (error: Error | null) => void;
};

export interface T3Stream {
	/** Stops the stream (sends an RPC Interrupt). `onEnd` is not called afterwards. */
	cancel(): void;
}

const PING_INTERVAL_MS = 15_000;
/**
 * T3 answers every Ping with a Pong, so a socket silent for this long is dead
 * (laptop asleep, NAT or tailnet dropped it) even though no close event came.
 */
export const SILENCE_TIMEOUT_MS = 3 * PING_INTERVAL_MS;

/** A single authenticated RPC socket. Create with {@link connectT3}, always `close()`. */
export class T3Connection {
	private nextId = 1;
	private readonly pending = new Map<string, Pending>();
	private readonly streams = new Map<string, StreamHandlers>();
	private readonly closeListeners = new Set<(error: Error) => void>();
	private closedError: Error | null = null;
	private readonly pingTimer: ReturnType<typeof setInterval>;
	private lastReceivedAt = Date.now();

	constructor(private readonly ws: WebSocket) {
		ws.addEventListener('message', (event) => {
			this.lastReceivedAt = Date.now();
			this.onMessage(event.data);
		});
		ws.addEventListener('close', () =>
			this.failAll(new T3ClientError('Connection closed', 'remote'))
		);
		ws.addEventListener('error', () =>
			this.failAll(new T3ClientError('Connection error', 'remote'))
		);
		// Keeps idle sockets (and proxies in between) from timing out.
		this.pingTimer = setInterval(() => {
			if (Date.now() - this.lastReceivedAt >= SILENCE_TIMEOUT_MS) {
				this.failAll(new T3ClientError('The coding machine stopped responding', 'unreachable'));
				return;
			}
			this.send({ _tag: 'Ping' });
		}, PING_INTERVAL_MS);
		this.pingTimer.unref?.();
	}

	get closed(): boolean {
		return this.closedError !== null;
	}

	/** Registers a listener for the socket closing (for any reason). Returns an unsubscribe. */
	onClose(listener: (error: Error) => void): () => void {
		if (this.closedError) {
			listener(this.closedError);
			return () => {};
		}
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	/**
	 * Starts a streaming RPC. Every chunk value is passed to `onValue` and acked
	 * (the server stops sending until it gets an Ack). `onEnd` fires once when the
	 * stream exits, fails or the socket closes.
	 */
	stream(tag: string, payload: unknown, handlers: StreamHandlers): T3Stream {
		const id = this.nextId++;
		const key = String(id);
		if (this.closedError) {
			const error = this.closedError;
			queueMicrotask(() => handlers.onEnd(error));
			return { cancel: () => {} };
		}
		this.streams.set(key, handlers);
		this.send({ _tag: 'Request', id, tag, payload, headers: [] });
		return {
			cancel: () => {
				if (!this.streams.delete(key)) return;
				this.send({ _tag: 'Interrupt', requestId: id });
			}
		};
	}

	/** Calls a one-shot (non-streaming) RPC and resolves with its success value. */
	call<T = unknown>(tag: string, payload: unknown, timeoutMs = CALL_TIMEOUT_MS): Promise<T> {
		if (this.closedError) return Promise.reject(this.closedError);
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(String(id));
				this.send({ _tag: 'Interrupt', requestId: id });
				reject(new T3ClientError(`${tag} timed out`, 'remote'));
			}, timeoutMs);
			this.pending.set(String(id), {
				resolve: resolve as (value: unknown) => void,
				reject,
				timer
			});
			this.send({ _tag: 'Request', id, tag, payload, headers: [] });
		});
	}

	close(): void {
		this.failAll(new T3ClientError('Connection closed', 'remote'));
	}

	private send(message: unknown): void {
		if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
	}

	private onMessage(data: unknown): void {
		if (typeof data !== 'string' || data.length > MAX_FRAME_BYTES) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(data);
		} catch {
			return;
		}
		for (const message of Array.isArray(parsed) ? parsed : [parsed]) this.handle(message);
	}

	private handle(message: unknown): void {
		if (!message || typeof message !== 'object') return;
		const m = message as Record<string, unknown>;
		if (m._tag === 'Ping') {
			this.send({ _tag: 'Pong' });
			return;
		}
		if (m._tag === 'Defect') {
			this.failAll(
				new T3ClientError(
					describeFailureCause([{ _tag: 'Die', defect: m.defect }]).message,
					'remote'
				)
			);
			return;
		}
		if (m._tag === 'ClientProtocolError') {
			this.failAll(new T3ClientError('Protocol error', 'protocol'));
			return;
		}
		if (m._tag === 'Pong') return;
		if (m._tag === 'Chunk') {
			const stream = this.streams.get(String(m.requestId));
			if (stream && Array.isArray(m.values)) {
				for (const value of m.values) {
					try {
						stream.onValue(value);
					} catch {
						// A consumer bug must not stall the stream.
					}
				}
			}
			// Always ack so the server never stalls, even for streams we dropped.
			if (m.requestId !== undefined) this.send({ _tag: 'Ack', requestId: m.requestId });
			return;
		}
		if (m._tag !== 'Exit') return;
		const key = String(m.requestId);
		const stream = this.streams.get(key);
		if (stream) {
			this.streams.delete(key);
			const exit = (m.exit ?? {}) as Record<string, unknown>;
			if (exit._tag === 'Success') {
				stream.onEnd(null);
			} else {
				const { message: text, unauthorized } = describeFailureCause(exit.cause);
				stream.onEnd(new T3ClientError(text, unauthorized ? 'unauthorized' : 'remote'));
			}
			return;
		}
		const pending = this.pending.get(key);
		if (!pending) return;
		this.pending.delete(key);
		clearTimeout(pending.timer);
		const exit = (m.exit ?? {}) as Record<string, unknown>;
		if (exit._tag === 'Success') {
			pending.resolve(exit.value);
		} else {
			const { message: text, unauthorized } = describeFailureCause(exit.cause);
			pending.reject(new T3ClientError(text, unauthorized ? 'unauthorized' : 'remote'));
		}
	}

	private failAll(error: Error): void {
		const first = this.closedError === null;
		this.closedError ??= error;
		clearInterval(this.pingTimer);
		for (const [key, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(error);
			this.pending.delete(key);
		}
		for (const [key, stream] of this.streams) {
			this.streams.delete(key);
			try {
				stream.onEnd(error);
			} catch {
				// A consumer bug must not keep other streams from ending.
			}
		}
		if (first) {
			// Failures reported in-band (Defect, protocol error) leave the socket
			// open; nothing uses it after this, so don't leak it.
			try {
				this.ws.close(1000);
			} catch {
				// already closed
			}
			for (const listener of this.closeListeners) {
				try {
					listener(error);
				} catch {
					// Same as above: every listener must hear about the close.
				}
			}
			this.closeListeners.clear();
		}
	}
}

/**
 * Authenticated JSON GET against the server's HTTP API (e.g. `/api/projects`).
 * Sends the orchestration protocol header the `/api/orchestration/*` routes require.
 */
/**
 * Downloads a binary T3 resource (a signed `/api/assets/…` URL), capped at
 * `maxBytes`. Returns null when T3 doesn't have it.
 */
export async function t3FetchBinary(
	baseUrl: string,
	token: string,
	path: string,
	maxBytes: number
): Promise<{ contentType: string; bytes: Uint8Array } | null> {
	const res = await fetchWithTimeout(
		joinUrl(baseUrl, path),
		{ headers: { authorization: `Bearer ${token}` } },
		BINARY_TIMEOUT_MS
	);
	if (res.status === 404) return null;
	if (res.status === 401 || res.status === 403) {
		throw new T3ClientError('Access token was rejected or lacks permission', 'unauthorized');
	}
	if (!res.ok || !res.body) {
		await res.body?.cancel().catch(() => {});
		throw new T3ClientError(`Request failed (${res.status})`, 'remote');
	}
	return {
		contentType: res.headers.get('content-type') ?? 'application/octet-stream',
		bytes: await readBody(res, maxBytes, 'File too large')
	};
}

export async function t3HttpGet<T = unknown>(
	baseUrl: string,
	token: string,
	path: string
): Promise<T> {
	const res = await fetchWithTimeout(joinUrl(baseUrl, path), {
		headers: {
			authorization: `Bearer ${token}`,
			accept: 'application/json',
			'x-t3-orchestration-protocol': String(ORCHESTRATION_PROTOCOL_VERSION)
		}
	});
	if (res.status === 401 || res.status === 403) {
		throw new T3ClientError('Access token was rejected or lacks permission', 'unauthorized');
	}
	if (!res.ok) throw new T3ClientError(`Request to ${path} failed (${res.status})`, 'remote');
	return (await readJson(res)) as T;
}

export async function connectT3(baseUrl: string, token: string): Promise<T3Connection> {
	const ticket = await issueWebSocketTicket(baseUrl, token);
	const url = new URL(joinUrl(baseUrl, '/ws'));
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
	url.searchParams.set('orchestrationProtocol', String(ORCHESTRATION_PROTOCOL_VERSION));
	url.searchParams.set('wsTicket', ticket);

	// Same DNS guard as the HTTP calls (undici's WebSocket honours `dispatcher`);
	// IP-literal hosts were already refused by the ticket request above. The DOM
	// typings only know the `protocols` form of the second argument.
	const init = { dispatcher: linkLocalGuardedAgent } as unknown as string[];
	const ws = new WebSocket(url, init);
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			ws.close();
			reject(new T3ClientError('WebSocket connection timed out', 'unreachable'));
		}, CONNECT_TIMEOUT_MS);
		ws.addEventListener(
			'open',
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true }
		);
		ws.addEventListener(
			'close',
			() => {
				clearTimeout(timer);
				reject(new T3ClientError('WebSocket connection was refused', 'remote'));
			},
			{ once: true }
		);
	});
	return new T3Connection(ws);
}
