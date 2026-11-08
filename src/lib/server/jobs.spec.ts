import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'chatty-jobs-'));
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';
process.env.WORKSPACES_VOLUME = root;

const { closeDb, getDb } = await import('./db/index.js');
const { createConversation } = await import('./db/repo/conversations.js');
const { createMessage } = await import('./db/repo/messages.js');
const { createAttachment, getAttachment, linkAttachmentsToMessage } =
	await import('./db/repo/attachments.js');
const { cleanupOrphanAttachments } = await import('./jobs.js');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

async function writeFile(conversationId: string, name: string, ageMs: number): Promise<string> {
	const dir = path.join(root, conversationId, 'attachments');
	await fsp.mkdir(dir, { recursive: true });
	const file = path.join(dir, name);
	await fsp.writeFile(file, 'x');
	const at = new Date(NOW - ageMs);
	await fsp.utimes(file, at, at);
	return file;
}

const exists = (file: string) =>
	fsp.stat(file).then(
		() => true,
		() => false
	);

function attach(conversationId: string, name: string) {
	return createAttachment(getDb(), {
		kind: 'image',
		path: path.join(conversationId, 'attachments', name),
		mime: 'image/png',
		sha256: 'x'
	});
}

beforeEach(async () => {
	closeDb();
	await fsp.rm(root, { recursive: true, force: true });
	await fsp.mkdir(root, { recursive: true });
	getDb()
		.prepare(
			`INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role)
			 VALUES ('u1', 'a@b.c', 'A', 0, 0, 0, 'user')`
		)
		.run();
});

afterAll(async () => {
	closeDb();
	await fsp.rm(root, { recursive: true, force: true });
});

describe('cleanupOrphanAttachments', () => {
	it('removes stale unsent uploads and files without a row, keeping the rest', async () => {
		const db = getDb();
		const conv = createConversation(db, 'u1').id;
		const message = createMessage(db, { conversationId: conv, role: 'user', parts: [] });

		const sentFile = await writeFile(conv, 'sent.png', 3 * DAY);
		const sent = attach(conv, 'sent.png');
		linkAttachmentsToMessage(db, message.id, [sent.id]);
		const staleFile = await writeFile(conv, 'stale.png', 2 * DAY);
		const stale = attach(conv, 'stale.png');
		const freshFile = await writeFile(conv, 'fresh.png', 60_000);
		const fresh = attach(conv, 'fresh.png');
		const missing = attach(conv, 'missing.png');
		const orphanFile = await writeFile(conv, 'orphan.png', 2 * 60 * 60 * 1000);
		const justWritten = await writeFile(conv, 'uploading.png', 1000);
		// Left behind by a conversation that was deleted.
		const goneConvFile = await writeFile('deleted-conv', 'old.png', 5 * DAY);

		const result = await cleanupOrphanAttachments(db, { now: NOW });

		expect(result).toEqual({ unlinkedRows: 2, orphanFiles: 2 });
		expect(getAttachment(db, sent.id)).toBeDefined();
		expect(await exists(sentFile)).toBe(true);
		expect(getAttachment(db, stale.id)).toBeUndefined();
		expect(await exists(staleFile)).toBe(false);
		expect(getAttachment(db, fresh.id)).toBeDefined();
		expect(await exists(freshFile)).toBe(true);
		expect(getAttachment(db, missing.id)).toBeUndefined();
		expect(await exists(orphanFile)).toBe(false);
		expect(await exists(justWritten)).toBe(true);
		expect(await exists(goneConvFile)).toBe(false);
	});

	it('cleans up files whose row was cascade-deleted with its message', async () => {
		const db = getDb();
		const conv = createConversation(db, 'u1').id;
		const message = createMessage(db, { conversationId: conv, role: 'user', parts: [] });
		const file = await writeFile(conv, 'pic.png', 2 * DAY);
		linkAttachmentsToMessage(db, message.id, [attach(conv, 'pic.png').id]);
		expect((await cleanupOrphanAttachments(db, { now: NOW })).orphanFiles).toBe(0);
		db.prepare('DELETE FROM messages WHERE id = ?').run(message.id);
		expect((await cleanupOrphanAttachments(db, { now: NOW })).orphanFiles).toBe(1);
		expect(await exists(file)).toBe(false);
	});

	it('keeps unlinked images of agent-run conversations', async () => {
		const db = getDb();
		const conv = createConversation(db, 'u1').id;
		db.prepare("UPDATE conversations SET kind = 'agent-run' WHERE id = ?").run(conv);
		const file = await writeFile(conv, 'generated.png', 3 * DAY);
		const row = attach(conv, 'generated.png');
		expect(await cleanupOrphanAttachments(db, { now: NOW })).toEqual({
			unlinkedRows: 0,
			orphanFiles: 0
		});
		expect(getAttachment(db, row.id)).toBeDefined();
		expect(await exists(file)).toBe(true);
	});
});
