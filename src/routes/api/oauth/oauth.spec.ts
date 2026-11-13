import { createHash, randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { isHttpError } from '@sveltejs/kit';

process.env.DATABASE_PATH = ':memory:';

const { closeDb, getDb } = await import('$lib/server/db/index.js');
const { deleteApiKey, listApiKeys } = await import('$lib/server/db/repo/api-keys.js');
const { listMcpServers } = await import('$lib/server/db/repo/mcp-servers.js');
const { csrfHandle } = await import('$lib/server/csrf.js');
const { safeRedirectPath } = await import('$lib/redirect-to.js');
const register = await import('./register/+server.js');
const token = await import('./token/+server.js');
const authorize = await import('./authorize/+server.js');
const mcp = await import('../mcp/+server.js');
const resourceMeta =
	await import('../../.well-known/oauth-protected-resource/[...path]/+server.js');
const serverMeta =
	await import('../../.well-known/oauth-authorization-server/[...path]/+server.js');

const ORIGIN = 'http://localhost';
const REDIRECT = 'http://127.0.0.1:33418/callback';
const user = { id: 'u1', role: 'user' };

type Handler = (event: never) => Response | Promise<Response>;

async function call(
	handler: Handler,
	path: string,
	init: { body?: BodyInit; headers?: Record<string, string>; user?: typeof user | null } = {}
): Promise<Response> {
	const url = new URL(path, ORIGIN);
	const request = new Request(url, {
		method: init.body === undefined ? 'GET' : 'POST',
		body: init.body,
		headers: init.headers
	});
	try {
		return await handler({
			request,
			url,
			params: {},
			getClientAddress: () => '127.0.0.1',
			locals: { user: init.user ?? null, session: null }
		} as never);
	} catch (e) {
		if (isHttpError(e)) return Response.json(e.body, { status: e.status });
		throw e;
	}
}

const jsonBody = (body: unknown) => ({
	body: JSON.stringify(body),
	headers: { 'content-type': 'application/json' }
});
const formBody = (params: Record<string, string>) => ({
	body: new URLSearchParams(params).toString(),
	headers: { 'content-type': 'application/x-www-form-urlencoded' }
});

function pkce() {
	const verifier = randomBytes(32).toString('base64url');
	return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function registerClient(): Promise<string> {
	const res = await call(
		register.POST as Handler,
		'/api/oauth/register',
		jsonBody({ client_name: 'Claude Code', redirect_uris: [REDIRECT] })
	);
	expect(res.status).toBe(201);
	return ((await res.json()) as { client_id: string }).client_id;
}

/** Approves the client as u1 with math only, and returns the code. */
async function approve(clientId: string, challenge: string, state = 'xyz'): Promise<string> {
	const query = new URLSearchParams({
		response_type: 'code',
		client_id: clientId,
		redirect_uri: REDIRECT,
		code_challenge: challenge,
		code_challenge_method: 'S256',
		state,
		resource: `${ORIGIN}/api/mcp`
	}).toString();
	const math = listMcpServers(getDb()).find((r) => r.name === 'math')!;
	const res = await call(authorize.POST as Handler, '/api/oauth/authorize', {
		...jsonBody({
			decision: 'approve',
			query,
			label: 'Claude Code',
			mcpAccess: [{ serverId: math.id, tools: ['calculate'] }]
		}),
		user
	});
	expect(res.status).toBe(200);
	const redirect = new URL(((await res.json()) as { redirectTo: string }).redirectTo);
	expect(redirect.origin + redirect.pathname).toBe(REDIRECT);
	expect(redirect.searchParams.get('state')).toBe(state);
	expect(redirect.searchParams.get('iss')).toBe(ORIGIN);
	return redirect.searchParams.get('code')!;
}

async function exchange(params: Record<string, string>) {
	const res = await call(token.POST as Handler, '/api/oauth/token', formBody(params));
	return { status: res.status, body: (await res.json()) as Record<string, string> };
}

async function listTools(accessToken: string): Promise<Response> {
	return call(mcp.POST as Handler, '/api/mcp', {
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
		headers: {
			authorization: `Bearer ${accessToken}`,
			'content-type': 'application/json',
			accept: 'application/json, text/event-stream'
		}
	});
}

beforeEach(() => {
	closeDb();
	getDb()
		.prepare(
			`INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role)
			 VALUES ('u1', 'a@b.c', 'A', 0, 0, 0, 'user')`
		)
		.run();
});

describe('MCP gateway OAuth', () => {
	it('advertises itself on 401 and through the metadata documents', async () => {
		const res = await call(mcp.POST as Handler, '/api/mcp', jsonBody({}));
		expect(res.status).toBe(401);
		expect(res.headers.get('www-authenticate')).toContain(
			`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/mcp"`
		);
		const resource = await (await call(resourceMeta.GET as Handler, '/x')).json();
		expect(resource).toMatchObject({
			resource: `${ORIGIN}/api/mcp`,
			authorization_servers: [ORIGIN]
		});
		const server = await (await call(serverMeta.GET as Handler, '/x')).json();
		expect(server).toMatchObject({
			issuer: ORIGIN,
			token_endpoint: `${ORIGIN}/api/oauth/token`,
			registration_endpoint: `${ORIGIN}/api/oauth/register`,
			code_challenge_methods_supported: ['S256']
		});
	});

	it('rejects redirect URIs that are neither https nor loopback', async () => {
		const res = await call(
			register.POST as Handler,
			'/api/oauth/register',
			jsonBody({ redirect_uris: ['http://evil.example/cb'] })
		);
		expect(res.status).toBe(400);
	});

	it('signs a client in, serves its tools, rotates and revokes', async () => {
		const clientId = await registerClient();
		const { verifier, challenge } = pkce();
		const code = await approve(clientId, challenge);

		// The approval is a key the user can see and manage.
		const keys = listApiKeys(getDb(), 'u1');
		expect(keys).toHaveLength(1);
		expect(keys[0]).toMatchObject({ label: 'Claude Code', oauth_client_name: 'Claude Code' });

		const wrong = await exchange({
			grant_type: 'authorization_code',
			code,
			client_id: clientId,
			redirect_uri: REDIRECT,
			code_verifier: pkce().verifier
		});
		expect(wrong.body.error).toBe('invalid_grant');

		// A failed attempt burns the code too.
		const replay = await exchange({
			grant_type: 'authorization_code',
			code,
			client_id: clientId,
			redirect_uri: REDIRECT,
			code_verifier: verifier
		});
		expect(replay.body.error).toBe('invalid_grant');

		const fresh = pkce();
		const code2 = await approve(clientId, fresh.challenge);
		// Signing in again reuses the key.
		expect(listApiKeys(getDb(), 'u1')).toHaveLength(1);
		const tokens = await exchange({
			grant_type: 'authorization_code',
			code: code2,
			client_id: clientId,
			redirect_uri: REDIRECT,
			code_verifier: fresh.verifier
		});
		expect(tokens.status).toBe(200);
		expect(tokens.body).toMatchObject({ token_type: 'Bearer', scope: 'mcp:use' });

		const listed = await listTools(tokens.body.access_token);
		expect(listed.status).toBe(200);
		const names = ((await listed.json()) as { result: { tools: { name: string }[] } }).result.tools
			.map((t) => t.name)
			.sort();
		expect(names).toEqual(['calculate']);

		const rotated = await exchange({
			grant_type: 'refresh_token',
			refresh_token: tokens.body.refresh_token,
			client_id: clientId
		});
		expect(rotated.status).toBe(200);
		const reused = await exchange({
			grant_type: 'refresh_token',
			refresh_token: tokens.body.refresh_token,
			client_id: clientId
		});
		expect(reused.body.error).toBe('invalid_grant');
		// Reusing a rotated refresh token means it leaked: the whole chain is revoked.
		expect((await listTools(rotated.body.access_token)).status).toBe(401);
		const afterReuse = await exchange({
			grant_type: 'refresh_token',
			refresh_token: rotated.body.refresh_token,
			client_id: clientId
		});
		expect(afterReuse.body.error).toBe('invalid_grant');

		// Signing in again works, and deleting the key signs the client out.
		const again = pkce();
		const tokens2 = await exchange({
			grant_type: 'authorization_code',
			code: await approve(clientId, again.challenge),
			client_id: clientId,
			redirect_uri: REDIRECT,
			code_verifier: again.verifier
		});
		expect((await listTools(tokens2.body.access_token)).status).toBe(200);

		deleteApiKey(getDb(), keys[0].id, 'u1');
		expect((await listTools(tokens2.body.access_token)).status).toBe(401);
	});

	it('sends a denial back to the client', async () => {
		const clientId = await registerClient();
		const query = new URLSearchParams({
			response_type: 'code',
			client_id: clientId,
			redirect_uri: REDIRECT,
			code_challenge: pkce().challenge,
			code_challenge_method: 'S256',
			state: 's1'
		}).toString();
		const res = await call(authorize.POST as Handler, '/api/oauth/authorize', {
			...jsonBody({ decision: 'deny', query }),
			user
		});
		const redirect = new URL(((await res.json()) as { redirectTo: string }).redirectTo);
		expect(redirect.searchParams.get('error')).toBe('access_denied');
		expect(redirect.searchParams.get('state')).toBe('s1');
		expect(listApiKeys(getDb(), 'u1')).toHaveLength(0);
	});

	it('never bounces a bad request back to a client nobody approved', async () => {
		const clientId = await registerClient();
		const query = new URLSearchParams({
			response_type: 'token',
			client_id: clientId,
			redirect_uri: REDIRECT
		}).toString();
		const res = await call(authorize.POST as Handler, '/api/oauth/authorize', {
			...jsonBody({ decision: 'deny', query }),
			user
		});
		expect(res.status).toBe(400);
	});

	it('refuses an unregistered redirect URI without redirecting', async () => {
		const clientId = await registerClient();
		const query = new URLSearchParams({
			response_type: 'code',
			client_id: clientId,
			redirect_uri: 'https://attacker.example/cb',
			code_challenge: pkce().challenge,
			code_challenge_method: 'S256'
		}).toString();
		const res = await call(authorize.POST as Handler, '/api/oauth/authorize', {
			...jsonBody({ decision: 'deny', query }),
			user
		});
		expect(res.status).toBe(400);
	});
});

describe('csrfHandle', () => {
	const run = (path: string, origin?: string) =>
		csrfHandle({
			event: {
				request: new Request(`${ORIGIN}${path}`, {
					method: 'POST',
					body: 'a=1',
					headers: {
						'content-type': 'application/x-www-form-urlencoded',
						...(origin ? { origin } : {})
					}
				}),
				url: new URL(path, ORIGIN)
			},
			resolve: () => new Response('ok')
		} as never) as Promise<Response>;

	it('blocks cross-site form posts but lets OAuth clients reach the token endpoint', async () => {
		expect((await run('/settings', 'https://evil.example')).status).toBe(403);
		expect((await run('/settings')).status).toBe(403);
		expect((await run('/settings', ORIGIN)).status).toBe(200);
		expect((await run('/api/oauth/token')).status).toBe(200);
	});
});

describe('safeRedirectPath', () => {
	it('only allows same-site paths', () => {
		expect(safeRedirectPath('/oauth/authorize?x=1')).toBe('/oauth/authorize?x=1');
		expect(safeRedirectPath('//evil.example')).toBe('/');
		expect(safeRedirectPath('https://evil.example')).toBe('/');
		expect(safeRedirectPath('/\t/evil.example')).toBe('/');
		expect(safeRedirectPath('/\\evil.example')).toBe('/');
		expect(safeRedirectPath('/\n/evil.example')).toBe('/');
		expect(safeRedirectPath('/%2F%2Fevil.example')).toBe('/%2F%2Fevil.example');
		expect(safeRedirectPath(null)).toBe('/');
	});
});
