import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { isHttpError } from '@sveltejs/kit';

const workspaces = await fs.mkdtemp(path.join(os.tmpdir(), 'chatty-attachments-'));
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';
process.env.WORKSPACES_VOLUME = workspaces;
process.env.MAX_ATTACHMENT_SIZE_MB = '1';

const { closeDb, getDb } = await import('$lib/server/db/index.js');
const { createConversation } = await import('$lib/server/db/repo/conversations.js');
const { POST } = await import('./+server.js');
const { GET } = await import('./[attachmentId]/+server.js');

let conversationId: string;

beforeEach(() => {
	closeDb();
	const db = getDb();
	db.prepare(
		`INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role)
		 VALUES ('u1', 'a@b.c', 'A', 0, 0, 0, 'user')`
	).run();
	conversationId = createConversation(db, 'u1').id;
});

afterAll(async () => {
	closeDb();
	await fs.rm(workspaces, { recursive: true, force: true });
});

async function upload(request: Request): Promise<{ status: number; body: unknown }> {
	const event = {
		locals: { user: { id: 'u1', role: 'user' }, session: null } as unknown as App.Locals,
		params: { id: conversationId },
		request
	};
	try {
		const res = await POST(event as never);
		return { status: res.status, body: await res.json() };
	} catch (e) {
		if (isHttpError(e)) return { status: e.status, body: e.body };
		throw e;
	}
}

const url = () => `http://localhost/api/conversations/${conversationId}/attachments`;

describe('POST /api/conversations/[id]/attachments', () => {
	it('stores the file and returns its conversation URL', async () => {
		const form = new FormData();
		form.append('file', new File(['hello'], 'note.txt', { type: 'text/plain' }));
		const res = await upload(new Request(url(), { method: 'POST', body: form }));
		expect(res.status).toBe(201);
		const { attachment } = res.body as { attachment: { id: string; url: string } };
		expect(attachment.url).toBe(
			`/api/conversations/${conversationId}/attachments/${attachment.id}`
		);
		const stored = await fs.readdir(path.join(workspaces, conversationId, 'attachments'));
		expect(stored.some((name) => name.endsWith('note.txt'))).toBe(true);
	});

	it('rejects an oversized content-length before reading the body', async () => {
		let bodyRead = false;
		const request = {
			headers: new Headers({ 'content-length': String(5 * 1024 * 1024) }),
			formData: async () => {
				bodyRead = true;
				return new FormData();
			}
		} as unknown as Request;
		const res = await upload(request);
		expect(res.status).toBe(413);
		expect(bodyRead).toBe(false);
	});

	it('rejects a file over the limit', async () => {
		const form = new FormData();
		form.append('file', new File([new Uint8Array(1024 * 1024 + 1)], 'big.bin'));
		// no content-length header, as with a chunked upload
		const request = { headers: new Headers(), formData: async () => form } as unknown as Request;
		const res = await upload(request);
		expect(res.status).toBe(413);
	});
});

describe('GET /api/conversations/[id]/attachments/[attachmentId]', () => {
	async function fetchAttachment(id: string, headers: Record<string, string> = {}) {
		const event = {
			locals: { user: { id: 'u1', role: 'user' }, session: null } as unknown as App.Locals,
			params: { id: conversationId, attachmentId: id },
			request: new Request(`${url()}/${id}`, { headers })
		};
		try {
			return await GET(event as never);
		} catch (e) {
			if (isHttpError(e)) return new Response(null, { status: e.status });
			throw e;
		}
	}

	async function uploadText(content: string): Promise<string> {
		const form = new FormData();
		form.append('file', new File([content], 'song.mp3', { type: 'audio/mpeg' }));
		const res = await upload(new Request(url(), { method: 'POST', body: form }));
		return (res.body as { attachment: { id: string } }).attachment.id;
	}

	it('streams the file with immutable caching and range support', async () => {
		const id = await uploadText('0123456789');
		const full = await fetchAttachment(id);
		expect(full.status).toBe(200);
		expect(await full.text()).toBe('0123456789');
		expect(full.headers.get('content-length')).toBe('10');
		expect(full.headers.get('content-type')).toBe('audio/mpeg');
		expect(full.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
		expect(full.headers.get('accept-ranges')).toBe('bytes');
		const part = await fetchAttachment(id, { range: 'bytes=7-' });
		expect(part.status).toBe(206);
		expect(await part.text()).toBe('789');
		expect(part.headers.get('content-range')).toBe('bytes 7-9/10');
	});

	it('returns 404 for an unknown attachment', async () => {
		expect((await fetchAttachment('nope')).status).toBe(404);
	});
});
