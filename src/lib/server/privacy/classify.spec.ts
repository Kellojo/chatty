import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.DATABASE_PATH = ':memory:';
process.env.MEMORY_VOLUME = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-classify-'));

/** What the fake Decisions model says yes to, and every request it got. */
const decisions = vi.hoisted(() => ({
	yes: [] as string[],
	calls: [] as unknown[],
	weak: false,
	/** Says yes only to inputs holding this text (a detail somewhere in a long note). */
	onlyWith: null as string | null,
	/** The call fails, as when the model is down. */
	failing: false,
	/** Replaces the answers (a provider's odd or partial reply). */
	answers: null as unknown[] | null,
	/** Runs while a request is in flight, e.g. to edit a note meanwhile. */
	during: null as (() => Promise<void>) | null
}));
vi.mock('../decisions/handler.js', async (importOriginal) => {
	const original = await importOriginal<typeof import('../decisions/handler.js')>();
	return {
		...original,
		forwardDecisions: vi.fn(
			async (
				request: { input: string; questions: { name: string }[] },
				privacy: { tainted: boolean },
				ref?: unknown
			) => {
				decisions.calls.push({ request, privacy, ref });
				await decisions.during?.();
				if (decisions.failing) throw new Error('model down');
				const matches = decisions.onlyWith === null || request.input.includes(decisions.onlyWith);
				return new Response(
					JSON.stringify({
						// LM Studio's decision models answer with a probability per question.
						answers:
							decisions.answers ??
							request.questions.map((q) => ({
								type: 'predicate',
								name: q.name,
								probability:
									matches && decisions.yes.includes(q.name) ? (decisions.weak ? 0.32 : 0.86) : 0.1
							}))
					})
				);
			}
		)
	};
});

const { closeDb, getDb } = await import('../db/index.js');
const { classifySensitive, canClassify, classificationWindows, verdictOf } =
	await import('./classify.js');
const { sweepMemoryPrivacy, recordPrivacyCheck } = await import('./sweep.js');
const { reviewUpdate, PRIVATE_REVIEW_NOTE } = await import('./classify.js');
const { TurnPrivacy } = await import('./taint.js');
const { createConversation } = await import('../db/repo/conversations.js');
const { seedPrivacyFixture, setRole } = await import('./fixtures.js');
const { deleteConcept, readConcept, writeConcept } = await import('../memory/bundle.js');
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
	decisions.onlyWith = null;
	decisions.failing = false;
	decisions.answers = null;
	decisions.during = null;
});

async function createConcept(args: Record<string, unknown>): Promise<string> {
	return callMemoryTool('create_concept', args);
}

/** Calls a memory tool; an untrusted chat's context unless `ctx` says otherwise. */
async function callMemoryTool(
	name: string,
	args: Record<string, unknown>,
	extra: Record<string, unknown> = {}
): Promise<string> {
	const ctx = { userId: fx.userId, role: 'admin', workspaceDir: null, documentsDir: '', ...extra };
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const server = createMemoryServer(ctx);
	await server.connect(serverTransport);
	const client = await createMCPClient({ transport: clientTransport, maxRetries: 0 });
	try {
		const tool = (await client.tools())[name] as unknown as {
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
			expect.objectContaining({
				privacy: expect.objectContaining({ tainted: true }),
				// The configured provider's model, not just its name (another provider may share it).
				ref: { providerId: fx.trusted.providerId, modelId: fx.trusted.modelId }
			})
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

	it('checks all of a long text, window by window', async () => {
		setRole(getDb(), 'decisions', fx.trusted);
		decisions.yes = ['contact'];
		decisions.onlyWith = '+49 170 1234567';
		const text = `${'harmless words '.repeat(500)}Call me on +49 170 1234567. ${'more '.repeat(300)}`;
		expect(text.indexOf('+49')).toBeGreaterThan(7000);
		expect(await classifySensitive(getDb(), text)).toEqual(['contact details']);
		expect(decisions.calls.length).toBe(classificationWindows(text).length);

		// Any failed window fails the check, so it isn't recorded as done.
		decisions.failing = true;
		expect(await classifySensitive(getDb(), text)).toBeNull();
	});

	it('fails on a reply it cannot read, instead of finding nothing', async () => {
		setRole(getDb(), 'decisions', fx.trusted);
		const all = [
			'health',
			'money',
			'contact',
			'birthdate',
			'name',
			'people',
			'secrets',
			'intimate'
		];
		decisions.answers = [];
		expect(await classifySensitive(getDb(), 'some text')).toBeNull();
		// One question missing.
		decisions.answers = all.slice(1).map((name) => ({ name, value: false }));
		expect(await classifySensitive(getDb(), 'some text')).toBeNull();
		// An answer without a verdict it knows.
		decisions.answers = all.map((name) => ({ name, verdict: 'maybe' }));
		expect(await classifySensitive(getDb(), 'some text')).toBeNull();
		// Booleans and yes/no strings in any of the known fields are read.
		decisions.answers = all.map((name) => ({ name, answer: name === 'money' ? 'yes' : 'no' }));
		expect(await classifySensitive(getDb(), 'some text')).toEqual(['money']);
	});

	it('reads verdicts from probabilities, booleans and yes/no', () => {
		expect(verdictOf({ probability: 0.31 })).toBe(true);
		expect(verdictOf({ probability: 0.2 })).toBe(false);
		expect(verdictOf({ value: false })).toBe(false);
		expect(verdictOf({ result: ' Yes ' })).toBe(true);
		expect(verdictOf({ choice: 'no' })).toBe(false);
		expect(verdictOf({ value: 'perhaps' })).toBeNull();
		expect(verdictOf({})).toBeNull();
	});

	it('stops when the Decisions model is untrusted between windows', async () => {
		setRole(getDb(), 'decisions', fx.trusted);
		decisions.during = async () => {
			setRole(getDb(), 'decisions', fx.untrusted);
		};
		expect(await classifySensitive(getDb(), 'z'.repeat(20_000))).toBeNull();
		expect(decisions.calls.length).toBe(1);
	});

	it('splits texts into overlapping windows that cover both ends, at most 8', () => {
		expect(classificationWindows('short')).toEqual(['short']);
		const mid = 'x'.repeat(20_000);
		const windows = classificationWindows(mid);
		expect(windows.length).toBe(4);
		expect(windows.every((w) => w.length <= 6000)).toBe(true);
		const huge = `START${'y'.repeat(200_000)}END`;
		const capped = classificationWindows(huge);
		expect(capped.length).toBe(8);
		expect(capped[0].startsWith('START')).toBe(true);
		expect(capped[7].endsWith('END')).toBe(true);
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

	it('sweep: skips a note it cannot check and still marks the next one', async () => {
		const db = getDb();
		const userId = 'sweep-poison';
		seedPrivacyFixture(db, undefined, userId);
		const save = (p: string, body: string) =>
			writeConcept(
				db,
				'user',
				userId,
				p,
				{ frontmatter: { title: p }, body },
				{ author: 't', userId }
			);
		await save('a-poison', 'POISON');
		await save('b-person', 'Katharina Schulz');
		setRole(db, 'decisions', fx.trusted);
		decisions.yes = ['name'];
		decisions.during = async () => {
			const last = decisions.calls.at(-1) as { request: { input: string } };
			decisions.failing = last.request.input.includes('POISON');
		};
		const res = await sweepMemoryPrivacy(db, 'user', userId);
		expect(res.marked).toEqual(['b-person.md']);
		expect(res.checked).toBe(2);
	});

	it('sweep: gives up after 3 failed checks in a row and records nothing', async () => {
		const db = getDb();
		const userId = 'sweep-down';
		seedPrivacyFixture(db, undefined, userId);
		for (const p of ['a', 'b', 'c', 'd']) {
			await writeConcept(
				db,
				'user',
				userId,
				p,
				{ frontmatter: { title: p }, body: 'text' },
				{ author: 't', userId }
			);
		}
		setRole(db, 'decisions', fx.trusted);
		decisions.failing = true;
		const down = await sweepMemoryPrivacy(db, 'user', userId);
		expect(down).toEqual({ checked: 3, marked: [], flagged: [] });
		expect(decisions.calls.length).toBe(3);
		// Back up: every note is still due.
		decisions.failing = false;
		expect((await sweepMemoryPrivacy(db, 'user', userId)).checked).toBe(4);
	});

	it('sweeps public notes once per content, and leaves a note made public alone', async () => {
		const db = getDb();
		// A user of its own, so notes from the other tests stay out of the sweep.
		const userId = 'sweeper';
		seedPrivacyFixture(db, undefined, userId);
		const note = (p: string, body: string) =>
			writeConcept(
				db,
				'user',
				userId,
				p,
				{ frontmatter: { title: p }, body },
				{ author: 't', userId }
			);
		await note('people/katharina', 'Send the invoice to Katharina Schulz');
		await note('recipes/bread', 'Sourdough: 500g flour');

		// Without a trusted Decisions model nothing is checked.
		expect(await sweepMemoryPrivacy(db, 'user', userId)).toEqual({
			checked: 0,
			marked: [],
			flagged: []
		});

		setRole(db, 'decisions', fx.trusted);
		decisions.yes = ['name'];
		// The fake flags every note it sees; only the first one is checked with a limit of 1.
		expect(await sweepMemoryPrivacy(db, 'user', userId, 1)).toEqual({
			checked: 1,
			marked: ['people/katharina.md'],
			flagged: []
		});
		const marked = await readConcept('user', userId, 'people/katharina');
		expect(marked?.frontmatter.privateReason).toBe(
			'Marked private automatically: looks like a full name'
		);

		decisions.yes = [];
		expect(await sweepMemoryPrivacy(db, 'user', userId)).toEqual({
			checked: 1,
			marked: [],
			flagged: []
		});
		// Nothing changed since: nothing to check.
		expect(await sweepMemoryPrivacy(db, 'user', userId)).toEqual({
			checked: 0,
			marked: [],
			flagged: []
		});

		// A person makes the marked note public again: the sweep respects that.
		await writeConcept(
			db,
			'user',
			userId,
			'people/katharina',
			{ frontmatter: { title: 'people/katharina', private: false }, body: marked!.body },
			{ author: 't', userId }
		);
		decisions.yes = ['name'];
		expect(await sweepMemoryPrivacy(db, 'user', userId)).toEqual({
			checked: 0,
			marked: [],
			flagged: []
		});
	});

	it('sweep: leaves a note edited, deleted or marked while it was classified', async () => {
		const db = getDb();
		setRole(db, 'decisions', fx.trusted);
		const body = 'Send the invoice to Katharina Schulz';
		/** A user with one public note, swept while `meanwhile` changes it. */
		type Save = (text: string, extra?: Record<string, unknown>) => Promise<unknown>;
		const sweepWhile = async (userId: string, meanwhile: (save: Save) => Promise<void>) => {
			seedPrivacyFixture(db, undefined, userId);
			const write: Save = (text, extra = {}) =>
				writeConcept(
					db,
					'user',
					userId,
					'a/note',
					{ frontmatter: { title: 'Note', ...extra }, body: text },
					{ author: 't', userId }
				);
			await write(body);
			decisions.yes = ['name'];
			decisions.during = async () => {
				decisions.during = null;
				await meanwhile(write);
			};
			// Classified as it was read, but that must not be written back.
			expect((await sweepMemoryPrivacy(db, 'user', userId)).marked).toEqual([]);
			return readConcept('user', userId, 'a/note');
		};

		const edited = await sweepWhile('racer-edit', (save) =>
			save('Send the invoice to accounting').then(() => undefined)
		);
		expect(edited?.body.trim()).toBe('Send the invoice to accounting');
		expect(edited?.frontmatter.private).toBeUndefined();
		// Not recorded as checked: the next run checks it as it is now.
		decisions.yes = [];
		expect((await sweepMemoryPrivacy(db, 'user', 'racer-edit')).checked).toBe(1);

		const gone = await sweepWhile('racer-delete', () =>
			deleteConcept(db, 'user', 'racer-delete', 'a/note', {
				author: 't',
				userId: 'racer-delete'
			}).then(() => undefined)
		);
		expect(gone).toBeNull();

		// A person makes it private meanwhile: their decision stands, without a reason.
		const marked = await sweepWhile('racer-mark', (save) =>
			save(body, { private: true }).then(() => undefined)
		);
		expect(marked?.frontmatter.private).toBe(true);
		expect(marked?.frontmatter.privateReason).toBeUndefined();
	});

	it('flags automatically marked notes that no longer look personal, and leaves the rest', () => {
		const auto = {
			private: true,
			privateReason: 'Marked private automatically: looks like health'
		};
		expect(reviewUpdate(auto, [])).toEqual({ privateReview: PRIVATE_REVIEW_NOTE });
		expect(reviewUpdate({ ...auto, privateReview: PRIVATE_REVIEW_NOTE }, [])).toBeNull();
		expect(reviewUpdate(auto, ['health'])).toBeNull();
		expect(reviewUpdate(auto, ['money'])).toEqual({
			private: true,
			privateReason: 'Marked private automatically: looks like money',
			privateReview: null
		});
		// Made private by a person (or a private chat): never second-guessed.
		expect(reviewUpdate({ private: true }, [])).toBeNull();
		expect(reviewUpdate(null, [])).toBeNull();
	});

	it('flags an edited note through the tool and the sweep; a person saving clears it', async () => {
		const db = getDb();
		// A user of its own, so notes from the other tests stay out of the sweep.
		const uid = 'reviewer';
		seedPrivacyFixture(db, undefined, uid);
		setRole(db, 'decisions', fx.trusted);
		decisions.yes = ['health'];
		await callMemoryTool(
			'create_concept',
			{ path: 'health/meds', title: 'Meds', body: 'Takes insulin daily.' },
			{ userId: uid }
		);

		// A trusted chat edits the note so nothing personal is left.
		const c = createConversation(db, uid, { private: false });
		decisions.yes = [];
		const text = await callMemoryTool(
			'update_concept',
			{ path: 'health/meds', body: 'Insulin is a hormone.' },
			{
				userId: uid,
				trust: 'trusted',
				conversationId: c.id,
				privacy: new TurnPrivacy(db, uid, { conversationId: c.id, trust: 'trusted' })
			}
		);
		expect(text).toContain('flagged for review');
		let note = await readConcept('user', uid, 'health/meds');
		expect(note?.frontmatter.private).toBe(true);
		expect(note?.frontmatter.privateReview).toBe(PRIVATE_REVIEW_NOTE);

		// A person saves it with Private on: confirmed, the flag goes.
		await writeConcept(
			db,
			'user',
			uid,
			'health/meds',
			{ frontmatter: { title: 'Meds', private: true }, body: note!.body },
			{ author: 't', userId: uid }
		);
		note = await readConcept('user', uid, 'health/meds');
		expect(note?.frontmatter.privateReview).toBeUndefined();
		expect(note?.frontmatter.privateReason).toBe('Marked private automatically: looks like health');

		// The editor records that a person decided: the sweep leaves the note alone…
		recordPrivacyCheck(db, note!, uid);
		expect((await sweepMemoryPrivacy(db, 'user', uid)).flagged).toEqual([]);
		// …until its text changes again.
		await writeConcept(
			db,
			'user',
			uid,
			'health/meds',
			{ frontmatter: { title: 'Meds' }, body: 'Insulin is made in the pancreas.' },
			{ author: 't', userId: uid }
		);
		expect((await sweepMemoryPrivacy(db, 'user', uid)).flagged).toEqual(['health/meds.md']);
	});
});
