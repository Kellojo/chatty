import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_PATH = ':memory:';
process.env.MEMORY_VOLUME = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-classify-'));

/** What the fake Decisions model says yes to, and every request it got. */
const decisions = vi.hoisted(() => ({ yes: [] as string[], calls: [] as unknown[], weak: false }));
vi.mock('../decisions/handler.js', async (importOriginal) => {
	const original = await importOriginal<typeof import('../decisions/handler.js')>();
	return {
		...original,
		forwardDecisions: vi.fn(
			async (request: { questions: { name: string }[] }, privacy: { tainted: boolean }) => {
				decisions.calls.push({ request, privacy });
				return new Response(
					JSON.stringify({
						// LM Studio's decision models answer with a probability per question.
						answers: request.questions.map((q) => ({
							type: 'predicate',
							name: q.name,
							probability: decisions.yes.includes(q.name) ? (decisions.weak ? 0.32 : 0.86) : 0.1
						}))
					})
				);
			}
		)
	};
});

const { closeDb, getDb } = await import('../db/index.js');
const { classifySensitive, canClassify } = await import('./classify.js');
const { seedPrivacyFixture, setRole } = await import('./fixtures.js');
const { readConcept, writeConcept } = await import('../memory/bundle.js');
const { createMemoryServer } = await import('../mcp/servers/memory.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { createMCPClient } = await import('@ai-sdk/mcp');

let fx: ReturnType<typeof seedPrivacyFixture>;
beforeEach(() => {
	closeDb();
	fx = seedPrivacyFixture(getDb());
	decisions.yes = [];
	decisions.calls = [];
	decisions.weak = false;
});

async function createConcept(args: Record<string, unknown>): Promise<string> {
	const ctx = { userId: fx.userId, role: 'admin', workspaceDir: null, documentsDir: '' };
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const server = createMemoryServer(ctx);
	await server.connect(serverTransport);
	const client = await createMCPClient({ transport: clientTransport, maxRetries: 0 });
	try {
		const tool = (await client.tools()).create_concept as unknown as {
			execute: (input: unknown, opts: unknown) => Promise<{ content: { text: string }[] }>;
		};
		const res = await tool.execute(args, { toolCallId: 't', messages: [] });
		return res.content[0].text;
	} finally {
		await client.close();
		await server.close();
	}
}

const audit = () => ({ author: 'test', userId: fx.userId });

describe('automatic privacy classification', () => {
	it('only runs on a Decisions model trusted with private data', async () => {
		const db = getDb();
		expect(canClassify(db)).toBe(false);
		expect(await classifySensitive(db, 'My blood pressure medication is ...')).toBeNull();
		setRole(db, 'decisions', fx.untrusted);
		expect(await classifySensitive(db, 'My blood pressure medication is ...')).toBeNull();
		expect(decisions.calls).toEqual([]);
	});

	it('names what it found, and sends the text as private', async () => {
		const db = getDb();
		setRole(db, 'decisions', fx.trusted);
		decisions.yes = ['health', 'money'];
		expect(await classifySensitive(db, 'Insulin costs me 80 EUR a month')).toEqual([
			'health',
			'money'
		]);
		expect(decisions.calls).toEqual([
			expect.objectContaining({ privacy: expect.objectContaining({ tainted: true }) })
		]);
		decisions.yes = [];
		expect(await classifySensitive(db, 'I like teal')).toEqual([]);
		// Any PII counts: a weak yes (a full name alone scores about 0.32) is enough.
		decisions.yes = ['name'];
		decisions.weak = true;
		expect(await classifySensitive(db, 'Send the invoice to Katharina Schulz')).toEqual([
			'a full name'
		]);
	});

	it('marks a sensitive note private when a memory tool saves it', async () => {
		setRole(getDb(), 'decisions', fx.trusted);
		decisions.yes = ['health'];
		const text = await createConcept({
			path: 'health/allergies',
			title: 'Allergies',
			body: 'Allergic to penicillin.'
		});
		expect(text).toContain('marked private automatically');
		const saved = await readConcept('user', fx.userId, 'health/allergies');
		expect(saved?.frontmatter.private).toBe(true);
		expect(saved?.frontmatter.privateReason).toBe(
			'Marked private automatically: looks like health'
		);

		decisions.yes = [];
		await createConcept({ path: 'prefs/colour', title: 'Colour', body: 'Likes teal.' });
		expect((await readConcept('user', fx.userId, 'prefs/colour'))?.frontmatter.private).toBe(
			undefined
		);
	});

	it('keeps the reason while the note stays private, and drops it when made public', async () => {
		const db = getDb();
		await writeConcept(
			db,
			'user',
			fx.userId,
			'a/b',
			{
				frontmatter: {
					title: 'B',
					private: true,
					privateReason: 'Marked private automatically: x'
				},
				body: 'x'
			},
			audit()
		);
		await writeConcept(
			db,
			'user',
			fx.userId,
			'a/b',
			{ frontmatter: { title: 'B2' }, body: 'y' },
			audit()
		);
		expect((await readConcept('user', fx.userId, 'a/b'))?.frontmatter.privateReason).toBe(
			'Marked private automatically: x'
		);
		await writeConcept(
			db,
			'user',
			fx.userId,
			'a/b',
			{ frontmatter: { title: 'B2', private: false }, body: 'y' },
			audit()
		);
		const publicNote = await readConcept('user', fx.userId, 'a/b');
		expect(publicNote?.frontmatter.private).toBeUndefined();
		expect(publicNote?.frontmatter.privateReason).toBeUndefined();
	});
});
