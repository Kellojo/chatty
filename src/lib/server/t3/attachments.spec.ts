import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

let dir = '';
vi.doMock('../workspaces.js', () => ({
	// Stored paths resolve into a temp dir, never the real workspaces.
	resolveAttachment: async (stored: string) => join(dir, stored.replace(/[\\/]/g, '_'))
}));
const t3PostBinary = vi.fn(async () => {});
vi.doMock('./client.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('./client.js')>()),
	t3PostBinary
}));

const { openDatabase } = await import('../db/index.js');
const { encryptSecret } = await import('../crypto.js');
const { createAttachment } = await import('../db/repo/attachments.js');
const { MAX_IMAGE_BYTES, readCodingAttachments, uploadCodingAttachments } =
	await import('./attachments.js');

type Db = ReturnType<typeof openDatabase>;
let db: Db;

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), 'chatty-coding-attachments-'));
});
afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});
beforeEach(() => {
	db = openDatabase(':memory:');
	t3PostBinary.mockClear();
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

async function stored(conversationId: string, name: string, mime: string, bytes: Buffer) {
	const path = `${conversationId}/attachments/${name}`;
	await writeFile(join(dir, path.replace(/[\\/]/g, '_')), bytes);
	return createAttachment(db, { kind: 'upload', path, mime, sha256: 'x' });
}

describe('readCodingAttachments', () => {
	it("reads this conversation's uploads and inline data URLs", async () => {
		const row = await stored('c1', 'shot.png', 'image/png', PNG);
		const files = await readCodingAttachments(db, 'c1', [
			{ type: 'text', text: 'look' },
			{
				type: 'file',
				mediaType: 'image/png',
				filename: 'shot.png',
				url: `/api/conversations/c1/attachments/${row.id}`
			},
			{
				type: 'file',
				mediaType: 'text/plain',
				filename: 'notes.txt',
				url: `data:text/plain;base64,${Buffer.from('hi').toString('base64')}`
			}
		]);
		expect(files.map((f) => [f.name, f.mimeType, Buffer.from(f.bytes).toString('hex')])).toEqual([
			['shot.png', 'image/png', PNG.toString('hex')],
			['notes.txt', 'text/plain', Buffer.from('hi').toString('hex')]
		]);
	});

	it("refuses another conversation's attachment", async () => {
		const row = await stored('c2', 'secret.txt', 'text/plain', Buffer.from('x'));
		await expect(
			readCodingAttachments(db, 'c1', [
				{
					type: 'file',
					mediaType: 'text/plain',
					url: `/api/conversations/c1/attachments/${row.id}`
				}
			])
		).rejects.toThrow('no longer available');
	});

	it("enforces T3's size limits", async () => {
		const big = Buffer.alloc(MAX_IMAGE_BYTES + 1).toString('base64');
		await expect(
			readCodingAttachments(db, 'c1', [
				{
					type: 'file',
					mediaType: 'image/png',
					filename: 'big.png',
					url: `data:image/png;base64,${big}`
				}
			])
		).rejects.toThrow('too large');
	});
});

describe('uploadCodingAttachments', () => {
	const env = { base_url: 'http://t3.test', token_enc: encryptSecret('token') };

	it('persists images inline and uploads other files, keeping their order', async () => {
		const call = vi.fn(async (tag: string, payload: unknown): Promise<unknown> => {
			if (tag === 'assets.persistChatAttachments') {
				const { attachments } = payload as { attachments: { name: string }[] };
				return {
					attachments: attachments.map((a, i) => ({
						type: 'image',
						id: `img-${i}`,
						name: a.name,
						mimeType: 'image/png',
						sizeBytes: 4
					}))
				};
			}
			if (tag === 'attachments.createUploadUrl') {
				return { attachmentId: 'file-1', relativeUrl: '/api/attachments/upload/sig', expiresAt: 0 };
			}
			throw new Error(`unexpected ${tag}`);
		});
		const refs = await uploadCodingAttachments({ call } as never, env, {
			threadId: 't1',
			messageId: 'm1',
			files: [
				{ name: 'notes.txt', mimeType: 'text/plain', bytes: Buffer.from('hi') },
				{ name: 'shot.png', mimeType: 'image/png', bytes: PNG }
			]
		});
		expect(refs).toEqual([
			{ type: 'file', id: 'file-1', name: 'notes.txt', mimeType: 'text/plain', sizeBytes: 2 },
			{ type: 'image', id: 'img-0', name: 'shot.png', mimeType: 'image/png', sizeBytes: 4 }
		]);
		expect(call).toHaveBeenCalledWith('assets.persistChatAttachments', {
			threadId: 't1',
			messageId: 'm1',
			attachments: [
				{
					type: 'image',
					name: 'shot.png',
					mimeType: 'image/png',
					sizeBytes: 4,
					dataUrl: `data:image/png;base64,${PNG.toString('base64')}`
				}
			]
		});
		expect(call).toHaveBeenCalledWith('attachments.createUploadUrl', {
			type: 'file',
			name: 'notes.txt',
			mimeType: 'text/plain',
			sizeBytes: 2
		});
		expect(t3PostBinary).toHaveBeenCalledWith(
			'http://t3.test',
			'token',
			'/api/attachments/upload/sig',
			'text/plain',
			Buffer.from('hi')
		);
	});

	it('refuses an upload URL that points elsewhere', async () => {
		const call = vi.fn(async () => ({ attachmentId: 'a', relativeUrl: 'https://evil.test/x' }));
		await expect(
			uploadCodingAttachments({ call } as never, env, {
				threadId: 't1',
				messageId: 'm1',
				files: [{ name: 'a.txt', mimeType: 'text/plain', bytes: Buffer.from('a') }]
			})
		).rejects.toThrow('upload URL');
		expect(t3PostBinary).not.toHaveBeenCalled();
	});
});
