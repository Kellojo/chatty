/**
 * OAuth for remote MCP servers (MCP authorization spec): each user signs in to the
 * authorization server a server advertises, and Chatty connects with that user's
 * access token. The OAuth protocol work (discovery, PKCE, code exchange, refresh,
 * dynamic registration) is done by @ai-sdk/mcp's `auth()`; this module stores its
 * state per user and decides how Chatty registers as a client:
 *
 * 1. a client registered by hand (client ID / secret set on the server),
 * 2. a Client ID Metadata Document: Chatty's client ID is the URL of a JSON
 *    document it serves, when the authorization server supports them,
 * 3. dynamic client registration (RFC 7591), when it offers a registration endpoint.
 */
import { randomBytes } from 'node:crypto';
import {
	auth,
	UnauthorizedError,
	type OAuthAuthorizationServerInformation,
	type OAuthClientInformation,
	type OAuthClientMetadata,
	type OAuthClientProvider,
	type OAuthTokens
} from '@ai-sdk/mcp';
import { config } from '../config.js';
import { decryptSecret, encryptSecret } from '../crypto.js';
import type { Db } from '../db/index.js';
import { getMcpServer, setMcpOAuthClientInfo, type McpServerRow } from '../db/repo/mcp-servers.js';
import {
	deleteMcpOAuthSession,
	getMcpOAuthSession,
	getMcpOAuthSessionByState,
	updateMcpOAuthSession
} from '../db/repo/mcp-oauth-sessions.js';

export const OAUTH_CALLBACK_PATH = '/api/mcp-oauth/callback';

/**
 * The fetch for an MCP server's OAuth requests (metadata, token exchange, refresh).
 * Without one, @ai-sdk/mcp refuses authorization servers that resolve to private
 * addresses unless they share the MCP server's origin, which rules out the usual
 * self-hosted setup (MCP server and identity provider on separate hostnames on the
 * LAN). These endpoints come from a server an admin configured, which Chatty already
 * connects to without that restriction. A wrapper, not `fetch` itself: the library
 * treats the global fetch as "no fetch given".
 */
export const oauthFetch: typeof fetch = (input, init) => fetch(input, init);
export const CLIENT_METADATA_PATH = '/api/mcp-oauth/client-metadata.json';
const DISCOVERY_TIMEOUT_MS = 10_000;

/** The user hasn't signed in to an OAuth MCP server (or their sign-in expired). */
export class McpSignInRequiredError extends Error {
	constructor(serverName: string) {
		super(`Not signed in to ${serverName}. Connect it under Settings → Connected apps.`);
		this.name = 'McpSignInRequiredError';
	}
}

/** Chatty's public origin: ORIGIN when configured, else the origin the request came in on. */
export function appOrigin(requestOrigin?: string | null): string {
	const origin = config.ORIGIN ?? requestOrigin;
	if (!origin) throw new Error('Set ORIGIN to Chatty’s public URL to use OAuth for MCP servers');
	return origin.replace(/\/+$/, '');
}

export function oauthRedirectUrl(origin: string): string {
	return `${origin}${OAUTH_CALLBACK_PATH}`;
}

export function clientMetadataUrl(origin: string): string {
	return `${origin}${CLIENT_METADATA_PATH}`;
}

/** The Client ID Metadata Document Chatty serves; its URL is Chatty's client ID. */
export function clientMetadataDocument(origin: string) {
	return {
		client_id: clientMetadataUrl(origin),
		client_name: 'Chatty',
		client_uri: origin,
		redirect_uris: [oauthRedirectUrl(origin)],
		grant_types: ['authorization_code', 'refresh_token'],
		response_types: ['code'],
		token_endpoint_auth_method: 'none',
		application_type: 'web'
	};
}

// ---------------------------------------------------------------------------
// Discovery: just enough to choose a registration method before calling auth().

interface AuthServerSummary {
	issuer: string;
	registrationEndpoint?: string;
	clientIdMetadataDocumentSupported: boolean;
}

async function fetchJson(url: string, init?: RequestInit): Promise<Record<string, unknown> | null> {
	try {
		const res = await fetch(url, {
			...init,
			headers: { accept: 'application/json', ...init?.headers },
			signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)
		});
		if (!res.ok) return null;
		return (await res.json()) as Record<string, unknown>;
	} catch {
		return null;
	}
}

/** The `resource_metadata` URL from an unauthenticated request's WWW-Authenticate challenge. */
async function challengedResourceMetadataUrl(serverUrl: string): Promise<string | null> {
	try {
		const res = await fetch(serverUrl, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				accept: 'application/json, text/event-stream'
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' }),
			signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)
		});
		await res.body?.cancel();
		const header = res.headers.get('www-authenticate') ?? '';
		return /resource_metadata="([^"]+)"/i.exec(header)?.[1] ?? null;
	} catch {
		return null;
	}
}

/** Finds the authorization server of an MCP server (RFC 9728, then RFC 8414 / OIDC discovery). */
export async function discoverAuthorizationServer(serverUrl: string): Promise<AuthServerSummary> {
	const url = new URL(serverUrl);
	const path = url.pathname.replace(/\/+$/, '');
	const candidates = [
		...(path ? [`${url.origin}/.well-known/oauth-protected-resource${path}`] : []),
		`${url.origin}/.well-known/oauth-protected-resource`
	];
	let resource: Record<string, unknown> | null = null;
	for (const candidate of candidates) {
		resource = await fetchJson(candidate);
		if (resource) break;
	}
	if (!resource) {
		const challenged = await challengedResourceMetadataUrl(serverUrl);
		if (challenged) resource = await fetchJson(challenged);
	}
	const servers = resource?.authorization_servers;
	const issuer = Array.isArray(servers) && typeof servers[0] === 'string' ? servers[0] : null;
	if (!issuer) {
		throw new Error(
			'This server doesn’t advertise an authorization server (no OAuth protected resource metadata).'
		);
	}

	const as = new URL(issuer);
	const asPath = as.pathname.replace(/\/+$/, '');
	const metadataUrls = [
		`${as.origin}/.well-known/oauth-authorization-server${asPath}`,
		`${as.origin}/.well-known/openid-configuration${asPath}`,
		...(asPath ? [`${as.origin}${asPath}/.well-known/openid-configuration`] : [])
	];
	for (const metadataUrl of metadataUrls) {
		const metadata = await fetchJson(metadataUrl);
		if (!metadata) continue;
		return {
			issuer: typeof metadata.issuer === 'string' ? metadata.issuer : issuer,
			registrationEndpoint:
				typeof metadata.registration_endpoint === 'string'
					? metadata.registration_endpoint
					: undefined,
			clientIdMetadataDocumentSupported: metadata.client_id_metadata_document_supported === true
		};
	}
	throw new Error(`Couldn’t read the metadata of the authorization server ${issuer}.`);
}

// ---------------------------------------------------------------------------
// Client registration, shared by every user of a server.

type RegistrationKind = 'manual' | 'metadata-document' | 'dynamic';

interface StoredRegistration {
	kind: RegistrationKind;
	/** The origin the registration's redirect URI points at. */
	origin: string;
	info: OAuthClientInformation;
}

function readRegistration(row: McpServerRow): StoredRegistration | null {
	if (!row.oauth_client_info_enc) return null;
	try {
		return JSON.parse(decryptSecret(row.oauth_client_info_enc)) as StoredRegistration;
	} catch {
		return null;
	}
}

function writeRegistration(
	db: Db,
	serverId: string,
	registration: StoredRegistration | null
): void {
	setMcpOAuthClientInfo(db, serverId, registration ? JSON.stringify(registration) : null);
}

/**
 * Makes sure the server has a client registration Chatty can sign in with. Dynamic
 * registration is left to auth(), which registers and saves through the provider.
 */
async function ensureRegistration(db: Db, row: McpServerRow, origin: string): Promise<void> {
	const existing = readRegistration(row);
	if (existing && existing.origin === origin) return;
	writeRegistration(db, row.id, null);

	const server = await discoverAuthorizationServer(row.url!);
	if (row.oauth_client_id) {
		writeRegistration(db, row.id, {
			kind: 'manual',
			origin,
			info: {
				client_id: row.oauth_client_id,
				...(row.oauth_client_secret_enc
					? { client_secret: decryptSecret(row.oauth_client_secret_enc) }
					: {}),
				issuer: server.issuer
			}
		});
		return;
	}
	const publicOrigin = new URL(origin).protocol === 'https:';
	if (server.clientIdMetadataDocumentSupported && publicOrigin) {
		writeRegistration(db, row.id, {
			kind: 'metadata-document',
			origin,
			info: { client_id: clientMetadataUrl(origin), issuer: server.issuer }
		});
		return;
	}
	if (server.registrationEndpoint) return;
	throw new Error(
		server.clientIdMetadataDocumentSupported
			? `The authorization server accepts client ID metadata documents, but Chatty needs a public https ORIGIN for that. Or register Chatty as a client with the redirect URL ${oauthRedirectUrl(origin)} and enter its client ID.`
			: `The authorization server doesn’t allow automatic client registration. Register Chatty as a client with the redirect URL ${oauthRedirectUrl(origin)} and enter its client ID on the server.`
	);
}

// ---------------------------------------------------------------------------
// The per-user provider @ai-sdk/mcp drives.

export class McpOAuthProvider implements OAuthClientProvider {
	/** Set when auth() wants the user sent to the authorization server. */
	authorizationUrl: URL | null = null;

	constructor(
		private readonly db: Db,
		private readonly serverId: string,
		private readonly userId: string,
		/** The origin of the request starting a sign-in; null when connecting for a chat. */
		private readonly origin: string | null = null
	) {}

	private row(): McpServerRow {
		const row = getMcpServer(this.db, this.serverId);
		if (!row) throw new Error('MCP server not found');
		return row;
	}

	private registration(): StoredRegistration | null {
		return readRegistration(this.row());
	}

	private session() {
		return getMcpOAuthSession(this.db, this.serverId, this.userId);
	}

	private update(fields: Parameters<typeof updateMcpOAuthSession>[3]): void {
		updateMcpOAuthSession(this.db, this.serverId, this.userId, fields);
	}

	private resolvedOrigin(): string {
		return this.origin ?? this.registration()?.origin ?? appOrigin();
	}

	get redirectUrl(): string {
		return oauthRedirectUrl(this.resolvedOrigin());
	}

	get clientMetadata(): OAuthClientMetadata {
		const row = this.row();
		return {
			client_name: 'Chatty',
			client_uri: this.resolvedOrigin(),
			redirect_uris: [this.redirectUrl],
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			token_endpoint_auth_method: row.oauth_client_secret_enc ? 'client_secret_basic' : 'none',
			...(row.oauth_scope ? { scope: row.oauth_scope } : {})
		};
	}

	clientInformation(): OAuthClientInformation | undefined {
		return this.registration()?.info;
	}

	saveClientInformation(info: OAuthClientInformation): void {
		writeRegistration(this.db, this.serverId, {
			kind: 'dynamic',
			origin: this.resolvedOrigin(),
			info
		});
	}

	isClientInformationDynamicallyRegistered(): boolean {
		return this.registration()?.kind === 'dynamic';
	}

	tokens(): OAuthTokens | undefined {
		const enc = this.session()?.tokens_enc;
		return enc ? (JSON.parse(decryptSecret(enc)) as OAuthTokens) : undefined;
	}

	saveTokens(tokens: OAuthTokens): void {
		this.update({ tokens_enc: encryptSecret(JSON.stringify(tokens)) });
	}

	redirectToAuthorization(authorizationUrl: URL): void {
		this.authorizationUrl = authorizationUrl;
	}

	saveCodeVerifier(codeVerifier: string): void {
		this.update({ code_verifier_enc: encryptSecret(codeVerifier) });
	}

	codeVerifier(): string {
		const enc = this.session()?.code_verifier_enc;
		if (!enc) throw new Error('No sign-in is in progress for this server');
		return decryptSecret(enc);
	}

	state(): string {
		return randomBytes(24).toString('base64url');
	}

	saveState(state: string): void {
		this.update({ state });
	}

	storedState(): string | undefined {
		return this.session()?.state ?? undefined;
	}

	authorizationServerInformation(): OAuthAuthorizationServerInformation | undefined {
		const raw = this.session()?.auth_server_info;
		return raw ? (JSON.parse(raw) as OAuthAuthorizationServerInformation) : undefined;
	}

	saveAuthorizationServerInformation(info: OAuthAuthorizationServerInformation): void {
		this.update({ auth_server_info: JSON.stringify(info) });
	}

	invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier'): void {
		if (scope === 'all' || scope === 'client') {
			// Only a registration Chatty made itself can be thrown away and redone.
			if (this.registration()?.kind === 'dynamic') writeRegistration(this.db, this.serverId, null);
		}
		if (scope === 'all') {
			deleteMcpOAuthSession(this.db, this.serverId, this.userId);
		} else if (scope === 'tokens') {
			this.update({ tokens_enc: null });
		} else if (scope === 'verifier') {
			this.update({ code_verifier_enc: null });
		}
	}
}

// ---------------------------------------------------------------------------
// Flows used by the API routes and the connection manager.

function assertOAuthServer(row: McpServerRow | undefined): asserts row is McpServerRow {
	if (!row || row.auth !== 'oauth' || !row.url || row.transport === 'stdio') {
		throw new Error('This MCP server doesn’t use OAuth');
	}
	if (row.enabled !== 1) throw new Error('This MCP server is turned off');
}

export type StartResult = { connected: true } | { connected: false; authorizeUrl: string };

/** Starts (or silently renews) a user's sign-in. Returns where to send the browser. */
export async function startMcpOAuth(
	db: Db,
	serverId: string,
	userId: string,
	requestOrigin: string
): Promise<StartResult> {
	const row = getMcpServer(db, serverId);
	assertOAuthServer(row);
	const origin = appOrigin(requestOrigin);
	await ensureRegistration(db, row, origin);
	const provider = new McpOAuthProvider(db, row.id, userId, origin);
	const result = await auth(provider, {
		serverUrl: row.url!,
		scope: row.oauth_scope ?? undefined,
		fetchFn: oauthFetch
	});
	if (result === 'AUTHORIZED') return { connected: true };
	if (!provider.authorizationUrl)
		throw new Error('The authorization server didn’t return a sign-in URL');
	return { connected: false, authorizeUrl: provider.authorizationUrl.href };
}

/** Completes a sign-in on the OAuth callback; returns the server it was for. */
export async function finishMcpOAuth(
	db: Db,
	params: { state: string; code: string; issuer: string | null },
	userId: string,
	requestOrigin: string
): Promise<McpServerRow> {
	const session = getMcpOAuthSessionByState(db, params.state);
	// The state ties the callback to the user who started the sign-in.
	if (!session || session.user_id !== userId)
		throw new Error('This sign-in link is invalid or expired');
	const row = getMcpServer(db, session.server_id);
	assertOAuthServer(row);
	const provider = new McpOAuthProvider(db, row.id, userId, appOrigin(requestOrigin));
	try {
		const result = await auth(provider, {
			serverUrl: row.url!,
			authorizationCode: params.code,
			callbackState: params.state,
			callbackIssuer: params.issuer ?? undefined,
			fetchFn: oauthFetch
		});
		if (result !== 'AUTHORIZED') throw new Error('Sign-in wasn’t completed');
	} finally {
		updateMcpOAuthSession(db, row.id, userId, { state: null, code_verifier_enc: null });
	}
	return row;
}

/** Forgets a user's tokens for a server. */
export function disconnectMcpOAuth(db: Db, serverId: string, userId: string): boolean {
	return deleteMcpOAuthSession(db, serverId, userId);
}

/** The provider a chat connects with; fails fast when the user never signed in. */
export function connectionAuthProvider(
	db: Db,
	row: McpServerRow,
	userId: string
): McpOAuthProvider {
	if (!getMcpOAuthSession(db, row.id, userId)?.tokens_enc) {
		throw new McpSignInRequiredError(row.name);
	}
	return new McpOAuthProvider(db, row.id, userId);
}

/** Maps the transport's "needs interactive sign-in" failure to a message users can act on. */
export function toSignInError(e: unknown, row: McpServerRow): unknown {
	return e instanceof UnauthorizedError ? new McpSignInRequiredError(row.name) : e;
}

/**
 * An error's message plus the reasons underneath it. Node's fetch rejects with a bare
 * "fetch failed" and keeps the actual reason (DNS, refused connection, TLS) in `cause`.
 */
export function describeError(e: unknown): string {
	const parts: string[] = [];
	let current: unknown = e;
	for (let depth = 0; current && depth < 4; depth++) {
		if (current instanceof Error) {
			const code = (current as { code?: unknown }).code;
			const text = current.message || String(current);
			parts.push(typeof code === 'string' && !text.includes(code) ? `${code} ${text}` : text);
			current = current.cause;
		} else {
			parts.push(String(current));
			break;
		}
	}
	return [...new Set(parts)].join(': ');
}
