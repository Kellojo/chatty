import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { isHttpError } from '@sveltejs/kit';

process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';
process.env.WORKSPACES_VOLUME = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-files-'));

const { closeDb, getDb } = await import('$lib/server/db/index.js');
const { createAgentRun } = await import('$lib/server/db/repo/agent-runs.js');
const { createAgent } = await import('$lib/server/db/repo/agents.js');
const { createConversation } = await import('$lib/server/db/repo/conversations.js');
const { conversationWorkspace, ensureAgentWorkspace } = await import('$lib/server/workspaces.js');
const { GET } = await import('./+server.js');

async function call(
	user: { id: string } | null,
	id: string,
	filePath: string,
	headers: Record<string, string> = {}
): Promise<{ status: number; text: string; headers: Headers | null }> {
	const url = new URL(`http://localhost/api/chat/${id}/workspace-files/${filePath}`);
	const event = {
		locals: { user, session: null } as unknown as App.Locals,
		params: { id, path: filePath },
		request: new Request(url, { headers }),
		url
	};
	try {
		const res = await GET(event as never);
		return { status: res.status, text: await res.text(), headers: res.headers };
	} catch (e) {
		if (isHttpError(e)) return { status: e.status, text: e.body.message, headers: null };
		throw e;
	}
}

const u1 = { id: 'u1' };
const u2 = { id: 'u2' };

function write(dir: string, name: string, content: string) {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, name), content);
}

async function seedAgentRun() {
	const db = getDb();
	const agent = createAgent(db, 'u1', { name: 'a', systemPrompt: 'x', triggerType: 'manual' });
	const conversation = createConversation(db, 'u1', { kind: 'agent-run', agentId: agent.id });
	const run = createAgentRun(db, {
		agentId: agent.id,
		userId: 'u1',
		trigger: 'manual',
		conversationId: conversation.id
	});
	return { conversation, dir: await ensureAgentWorkspace(agent.id, run.id) };
}

beforeEach(() => {
	closeDb();
	getDb()
		.prepare(
			`INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role) VALUES
			 ('u1', 'a@b.c', 'A', 0, 0, 0, 'user'),
			 ('u2', 'd@e.f', 'D', 0, 0, 0, 'user')`
		)
		.run();
});

describe('GET /api/chat/[id]/workspace-files/[...path]', () => {
	it('serves files from a chat conversation workspace', async () => {
		const conversation = createConversation(getDb(), 'u1');
		write(conversationWorkspace(conversation.id), 'notes.md', '# hi');
		const res = await call(u1, conversation.id, 'notes.md');
		expect(res.status).toBe(200);
		expect(res.text).toBe('# hi');
		expect(res.headers?.get('content-type')).toBe('text/markdown');
		expect(res.headers?.get('content-disposition')).toContain('inline');
	});

	it('serves files from the agent workspace of an agent-run conversation', async () => {
		const { conversation, dir } = await seedAgentRun();
		write(path.join(dir, 'src'), 'app.ts', 'export {};');
		const res = await call(u1, conversation.id, 'src/app.ts');
		expect(res.status).toBe(200);
		expect(res.text).toBe('export {};');
	});

	it('does not serve agent-run files from the conversation workspace', async () => {
		const { conversation } = await seedAgentRun();
		write(conversationWorkspace(conversation.id), 'stray.txt', 'nope');
		expect((await call(u1, conversation.id, 'stray.txt')).status).toBe(404);
	});

	it('returns 404 to other users', async () => {
		const { conversation, dir } = await seedAgentRun();
		write(dir, 'secret.txt', 'x');
		expect((await call(u2, conversation.id, 'secret.txt')).status).toBe(404);
	});

	it('rejects paths escaping the workspace', async () => {
		const { conversation, dir } = await seedAgentRun();
		write(path.dirname(dir), 'outside.txt', 'x');
		expect((await call(u1, conversation.id, '../outside.txt')).status).toBe(404);
	});

	it('revalidates with ETag and answers a matching If-None-Match with 304', async () => {
		const conversation = createConversation(getDb(), 'u1');
		write(conversationWorkspace(conversation.id), 'page.html', '<p>v1</p>');
		const first = await call(u1, conversation.id, 'page.html');
		expect(first.headers?.get('cache-control')).toBe('private, no-cache');
		const etag = first.headers?.get('etag');
		expect(etag).toBeTruthy();
		const again = await call(u1, conversation.id, 'page.html', { 'if-none-match': etag! });
		expect(again.status).toBe(304);
		expect(again.text).toBe('');
		// An agent rewrites the file: the old ETag no longer matches.
		const file = path.join(conversationWorkspace(conversation.id), 'page.html');
		fs.writeFileSync(file, '<p>version 2</p>');
		fs.utimesSync(file, new Date(), new Date(Date.now() + 10_000));
		const changed = await call(u1, conversation.id, 'page.html', { 'if-none-match': etag! });
		expect(changed.status).toBe(200);
		expect(changed.text).toBe('<p>version 2</p>');
	});

	it('serves byte ranges so media can seek', async () => {
		const conversation = createConversation(getDb(), 'u1');
		write(conversationWorkspace(conversation.id), 'clip.mp4', '0123456789');
		const res = await call(u1, conversation.id, 'clip.mp4', { range: 'bytes=3-6' });
		expect(res.status).toBe(206);
		expect(res.text).toBe('3456');
		expect(res.headers?.get('content-range')).toBe('bytes 3-6/10');
		expect(res.headers?.get('accept-ranges')).toBe('bytes');
		expect(res.headers?.get('content-type')).toBe('video/mp4');
	});

	it('returns 404 for an agent-run conversation without a run', async () => {
		const conversation = createConversation(getDb(), 'u1', { kind: 'agent-run' });
		expect((await call(u1, conversation.id, 'a.txt')).status).toBe(404);
	});
});
