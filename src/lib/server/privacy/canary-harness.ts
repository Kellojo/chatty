/**
 * Shared harness for the egress canary specs (`canary*.spec.ts`).
 *
 * A local HTTP server records every request body. The fixture's trusted
 * provider points at `/trusted/v1`, the untrusted one at `/untrusted/v1`.
 * A row drives one path by which data leaves Chatty and calls `expectNoLeak()`:
 * the untrusted provider must never receive CANARY. Rows should also check that
 * the trusted side got the call, so a row can't pass by doing nothing.
 *
 * Usage, at the top level of a spec (after setting DATABASE_PATH and friends):
 *   const canary = useCanaryServer();
 *   ... canary.fx, canary.recorded, canary.expectNoLeak(), canary.privateChat(...)
 * Only imported by specs.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, expect } from 'vitest';
import { closeDb, getDb } from '../db/index.js';
import { createConversation } from '../db/repo/conversations.js';
import { createMessage } from '../db/repo/messages.js';
import {
	CANARY,
	markConversationPrivate,
	seedPrivacyFixture,
	type PrivacyFixture
} from './fixtures.js';

export { CANARY };

export interface Recorded {
	kind: 'trusted' | 'untrusted';
	path: string;
	body: string;
}

const completion = (stream: boolean) =>
	stream
		? [
				{ choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' } }] },
				{
					choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
					usage: { prompt_tokens: 1, completion_tokens: 1 }
				}
			]
				.map((c) => `data: ${JSON.stringify({ id: 'x', created: 0, model: 'm', ...c })}\n\n`)
				.join('') + 'data: [DONE]\n\n'
		: JSON.stringify({
				id: 'x',
				created: 0,
				model: 'm',
				choices: [
					{
						index: 0,
						message: { role: 'assistant', content: 'A summary.' },
						finish_reason: 'stop'
					}
				],
				usage: { prompt_tokens: 1, completion_tokens: 1 }
			});

function respond(req: http.IncomingMessage, res: http.ServerResponse, body: string): void {
	const url = req.url ?? '';
	const send = (type: string, payload: string | Buffer) => {
		res.writeHead(200, { 'content-type': type });
		res.end(payload);
	};
	if (url.endsWith('/chat/completions')) {
		const stream = /"stream":\s*true/.test(body);
		send(stream ? 'text/event-stream' : 'application/json', completion(stream));
	} else if (url.endsWith('/audio/transcriptions')) {
		send('application/json', JSON.stringify({ text: 'transcript' }));
	} else if (url.endsWith('/audio/speech')) {
		send('audio/mpeg', Buffer.from([1, 2, 3]));
	} else if (url.endsWith('/audio/voices')) {
		send('application/json', JSON.stringify({ voices: ['alloy'] }));
	} else if (url.endsWith('/decisions')) {
		send('application/json', JSON.stringify({ decisions: [] }));
	} else if (url.endsWith('/images/generations')) {
		send(
			'application/json',
			JSON.stringify({ data: [{ b64_json: Buffer.from('png').toString('base64') }] })
		);
	} else {
		res.writeHead(404);
		res.end();
	}
}

export interface CanaryServer {
	/** Every request the providers got in this test. */
	readonly recorded: Recorded[];
	/** The fixture of this test (fresh DB per test). */
	readonly fx: PrivacyFixture;
	readonly base: string;
	untrustedSaw(): Recorded[];
	trustedSaw(): Recorded[];
	/** The row's invariant: the canary never reached the untrusted provider. */
	expectNoLeak(): void;
	/** A private conversation on `model` whose history holds the canary. */
	privateChat(
		model: { providerId: string; modelId: string },
		messages?: number
	): ReturnType<typeof createConversation>;
	/** Reads a chat turn's response to the end and lets its onEnd persist. */
	drain(res: Response): Promise<void>;
}

/**
 * Starts the recording server for the spec and resets the DB and fixture
 * before each test. `opts.keepMcpServers` leaves the builtin MCP servers
 * enabled (off by default, so model rows don't build tools).
 */
export function useCanaryServer(opts: { keepMcpServers?: boolean } = {}): CanaryServer {
	const recorded: Recorded[] = [];
	let server: http.Server;
	let base = '';
	let fx: PrivacyFixture;

	beforeAll(async () => {
		server = http.createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on('data', (c: Buffer) => chunks.push(c));
			req.on('end', () => {
				// Binary bodies (audio uploads) are searched as latin1, which keeps ASCII intact.
				const body = Buffer.concat(chunks).toString('latin1');
				const kind = (req.url ?? '').startsWith('/trusted/') ? 'trusted' : 'untrusted';
				recorded.push({ kind, path: req.url ?? '', body });
				respond(req, res, body);
			});
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	afterAll(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	beforeEach(() => {
		closeDb();
		recorded.length = 0;
		const db = getDb();
		fx = seedPrivacyFixture(db, (kind) => `${base}/${kind}/v1`);
		if (!opts.keepMcpServers) db.prepare('UPDATE mcp_servers SET enabled = 0').run();
	});

	const untrustedSaw = () => recorded.filter((r) => r.kind === 'untrusted');
	return {
		recorded,
		get fx() {
			return fx;
		},
		get base() {
			return base;
		},
		untrustedSaw,
		trustedSaw: () => recorded.filter((r) => r.kind === 'trusted'),
		expectNoLeak: () =>
			expect(
				untrustedSaw()
					.filter((r) => r.body.includes(CANARY))
					.map((r) => r.path)
			).toEqual([]),
		privateChat(model, messages = 2) {
			const db = getDb();
			const c = createConversation(db, fx.userId, { title: 'secret', ...model, private: true });
			markConversationPrivate(db, c.id);
			for (let i = 0; i < messages; i++) {
				createMessage(db, {
					conversationId: c.id,
					role: i % 2 === 0 ? 'user' : 'assistant',
					parts: [{ type: 'text', text: `${CANARY} ${'x'.repeat(400)}` }]
				});
			}
			return db.prepare('SELECT * FROM conversations WHERE id = ?').get(c.id) as ReturnType<
				typeof createConversation
			>;
		},
		async drain(res) {
			await res.text();
			await new Promise((r) => setTimeout(r, 50));
		}
	};
}
