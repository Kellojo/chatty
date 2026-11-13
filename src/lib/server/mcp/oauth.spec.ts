import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';
// A public https origin, so client ID metadata documents are an option.
process.env.ORIGIN = 'https://chatty.example';

const { closeDb, getDb } = await import('$lib/server/db/index.js');
const { createMcpServer, getMcpServer, updateMcpServer } =
	await import('$lib/server/db/repo/mcp-servers.js');
const { getMcpOAuthSession } = await import('$lib/server/db/repo/mcp-oauth-sessions.js');
const { finishMcpOAuth, startMcpOAuth, McpSignInRequiredError } = await import('./oauth.js');
const { connectServer } = await import('./clientManager.js');

/** How the mock authorization server lets clients register. */
const as = { dynamicRegistration: true, metadataDocuments: false };
const tokenRequests: URLSearchParams[] = [];
let base = '';

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
	res.writeHead(status, { 'content-type': 'application/json' });
	res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<string> {
	let body = '';
	for await (const chunk of req) body += chunk;
	return body;
}

/** One origin playing both the MCP resource server and its authorization server. */
const mock = http.createServer(async (req, res) => {
	const url = new URL(req.url ?? '/', base);
	if (url.pathname === '/.well-known/oauth-protected-resource/mcp') {
		return sendJson(res, 200, { resource: `${base}/mcp`, authorization_servers: [base] });
	}
	if (url.pathname === '/.well-known/oauth-authorization-server') {
		return sendJson(res, 200, {
			issuer: base,
			authorization_endpoint: `${base}/authorize`,
			token_endpoint: `${base}/token`,
			...(as.dynamicRegistration ? { registration_endpoint: `${base}/register` } : {}),
			client_id_metadata_document_supported: as.metadataDocuments,
			response_types_supported: ['code'],
			code_challenge_methods_supported: ['S256'],
			token_endpoint_auth_methods_supported: ['none']
		});
	}
	if (url.pathname === '/register' && req.method === 'POST') {
		const metadata = JSON.parse(await readBody(req));
		return sendJson(res, 201, { ...metadata, client_id: 'dynamic-client' });
	}
	if (url.pathname === '/token' && req.method === 'POST') {
		const params = new URLSearchParams(await readBody(req));
		tokenRequests.push(params);
		if (params.get('code') !== 'good-code') return sendJson(res, 400, { error: 'invalid_grant' });
		return sendJson(res, 200, {
			access_token: 'access-1',
			token_type: 'Bearer',
			expires_in: 3600,
			refresh_token: 'refresh-1'
		});
	}
	if (url.pathname === '/mcp') {
		if (req.headers.authorization !== 'Bearer access-1') {
			res.writeHead(401, {
				'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`
			});
			return res.end();
		}
		const server = new McpServer({ name: 'mock', version: '1.0.0' });
		server.registerTool('whoami', { description: 'Who is calling' }, async () => ({
			content: [{ type: 'text', text: 'you' }]
		}));
		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
			enableJsonResponse: true
		});
		await server.connect(transport);
		const body = req.method === 'POST' ? JSON.parse(await readBody(req)) : undefined;
		await transport.handleRequest(req, res, body);
		return;
	}
	res.writeHead(404).end();
});

beforeAll(async () => {
	await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
	base = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => mock.close(() => resolve())));

beforeEach(() => {
	closeDb();
	as.dynamicRegistration = true;
	as.metadataDocuments = false;
	tokenRequests.length = 0;
	getDb()
		.prepare(
			`INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role) VALUES
			 ('u1', 'a@b.c', 'A', 0, 0, 0, 'user'),
			 ('u2', 'd@e.f', 'D', 0, 0, 0, 'user')`
		)
		.run();
});

function oauthServer() {
	return createMcpServer(getDb(), {
		name: 'tracker',
		transport: 'http',
		url: `${base}/mcp`,
		auth: 'oauth'
	});
}

const ctx = (userId: string) => ({ userId, role: 'user', workspaceDir: null, documentsDir: '' });

/** Starts a sign-in and returns the authorization URL's query. */
async function start(serverId: string, userId: string): Promise<URLSearchParams> {
	const result = await startMcpOAuth(getDb(), serverId, userId, 'https://ignored.example');
	expect(result.connected).toBe(false);
	if (result.connected) throw new Error('unreachable');
	const url = new URL(result.authorizeUrl);
	expect(`${url.origin}${url.pathname}`).toBe(`${base}/authorize`);
	return url.searchParams;
}

describe('MCP OAuth sign-in', () => {
	it('registers dynamically, exchanges the code and connects as that user only', async () => {
		const server = oauthServer();
		const query = await start(server.id, 'u1');
		expect(query.get('client_id')).toBe('dynamic-client');
		expect(query.get('code_challenge_method')).toBe('S256');
		expect(query.get('resource')).toBe(`${base}/mcp`);
		expect(query.get('redirect_uri')).toBe('https://chatty.example/api/mcp-oauth/callback');

		await finishMcpOAuth(
			getDb(),
			{ state: query.get('state')!, code: 'good-code', issuer: base },
			'u1',
			'https://ignored.example'
		);
		expect(tokenRequests[0].get('code_verifier')).toBeTruthy();
		expect(getMcpOAuthSession(getDb(), server.id, 'u1')?.tokens_enc).toBeTruthy();
		// The finished sign-in can't be replayed.
		expect(getMcpOAuthSession(getDb(), server.id, 'u1')?.state).toBeNull();

		const row = getMcpServer(getDb(), server.id)!;
		const conn = await connectServer(row, ctx('u1'));
		try {
			expect(Object.keys(await conn.client.tools())).toEqual(['whoami']);
		} finally {
			await conn.close();
		}
		await expect(connectServer(row, ctx('u2'))).rejects.toBeInstanceOf(McpSignInRequiredError);
	});

	it('uses a client ID metadata document when the authorization server accepts them', async () => {
		as.metadataDocuments = true;
		as.dynamicRegistration = false;
		const query = await start(oauthServer().id, 'u1');
		expect(query.get('client_id')).toBe(
			'https://chatty.example/api/mcp-oauth/client-metadata.json'
		);
	});

	it('prefers a client registered by hand', async () => {
		const server = oauthServer();
		updateMcpServer(getDb(), server.id, { oauthClientId: 'manual-client' });
		const query = await start(server.id, 'u1');
		expect(query.get('client_id')).toBe('manual-client');
	});

	it('explains what to do when the client can’t register itself', async () => {
		as.dynamicRegistration = false;
		await expect(
			startMcpOAuth(getDb(), oauthServer().id, 'u1', 'https://ignored.example')
		).rejects.toThrow(/Register Chatty as a client/);
	});

	it('only lets the user who started a sign-in finish it', async () => {
		const server = oauthServer();
		const query = await start(server.id, 'u1');
		await expect(
			finishMcpOAuth(
				getDb(),
				{ state: query.get('state')!, code: 'good-code', issuer: base },
				'u2',
				'https://ignored.example'
			)
		).rejects.toThrow(/invalid or expired/);
		expect(tokenRequests).toHaveLength(0);
	});

	it('forgets every user’s tokens when the server URL changes', async () => {
		const server = oauthServer();
		const query = await start(server.id, 'u1');
		await finishMcpOAuth(
			getDb(),
			{ state: query.get('state')!, code: 'good-code', issuer: base },
			'u1',
			'https://ignored.example'
		);
		updateMcpServer(getDb(), server.id, { url: `${base}/other` });
		expect(getMcpOAuthSession(getDb(), server.id, 'u1')).toBeUndefined();
		expect(getMcpServer(getDb(), server.id)?.oauth_client_info_enc).toBeNull();
	});
});
