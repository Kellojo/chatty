import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

// Loading T3's stored copy fails offline, so pages fall back to the tool input.
vi.doMock('./client.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./client.js')>();
	return {
		...actual,
		connectT3: vi.fn(async () => {
			throw new actual.T3ClientError('Server unreachable', 'unreachable');
		})
	};
});

const { openDatabase } = await import('../db/index.js');
const conversations = await import('../db/repo/conversations.js');
const coding = await import('../db/repo/coding-conversations.js');
const { createMessage } = await import('../db/repo/messages.js');
const { createCodingEnvironment } = await import('../db/repo/coding-environments.js');
const { fetchHtmlRenderPage, injectHtmlRenderBootstrap } = await import('./html-render.js');

type Db = ReturnType<typeof openDatabase>;
let db: Db;
let conversationId: string;

const renderPart = (toolCallId: string, html: string, output: unknown) => ({
	type: 'dynamic-tool',
	toolName: 'mcp__t3-code__html_render',
	toolCallId,
	state: 'output-available',
	input: { title: 'Demo', height: 200, html },
	output
});

beforeEach(() => {
	db = openDatabase(':memory:');
	const now = Date.now();
	for (const id of ['u1', 'u2']) {
		db.prepare(
			`INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, role) VALUES (?, ?, ?, 0, ?, ?, 'user')`
		).run(id, id, `${id}@example.com`, now, now);
	}
	const env = createCodingEnvironment(db, 'u1', {
		name: 'T3',
		baseUrl: 'http://t3.test',
		token: 'token'
	});
	conversationId = conversations.createConversation(db, 'u1', {
		kind: 'chat',
		mode: 'agent',
		title: 'Task'
	}).id;
	coding.createCodingConversation(db, {
		conversationId,
		environmentId: env.id,
		projectId: 'p1',
		projectTitle: 'Project',
		providerInstanceId: 'claudeAgent',
		model: 'claude',
		runtimeMode: 'auto',
		workspaceMode: 'local',
		baseBranch: null
	});
	coding.updateCodingConversation(db, conversationId, { threadId: 't1' });
	createMessage(db, {
		conversationId,
		role: 'assistant',
		parts: [
			renderPart('call-1', '<html><head><title>x</title></head><body>Hi</body></html>', {
				htmlRender: { attachmentId: 'att-1', title: 'Demo', height: 200 }
			}),
			renderPart('call-2', '<p>refused</p>', 'Error: page uses vh units')
		] as never
	});
});

const status = (userId: string, call: string) =>
	fetchHtmlRenderPage(db, userId, conversationId, call).then(
		() => 200,
		(e: { status: number }) => e.status
	);

describe('fetchHtmlRenderPage', () => {
	it('falls back to the tool input, with the bootstrap, when T3 is unreachable', async () => {
		const page = await fetchHtmlRenderPage(db, 'u1', conversationId, 'call-1');
		expect(page.source).toBe('local');
		expect(page.html).toContain('<head><meta charset="utf-8">');
		expect(page.html).toContain('<body>Hi</body>');
	});

	it('only serves published pages of the owner', async () => {
		expect(await status('u2', 'call-1')).toBe(404);
		expect(await status('u1', 'call-2')).toBe(404);
		expect(await status('u1', 'nope')).toBe(404);
	});
});

describe('injectHtmlRenderBootstrap', () => {
	it('goes at the start of the head', () => {
		const out = injectHtmlRenderBootstrap(
			'<!doctype html><html><head><title>t</title></head></html>'
		);
		expect(out.indexOf('id="t3-theme"')).toBeGreaterThan(out.indexOf('<head>'));
		expect(out.indexOf('id="t3-theme"')).toBeLessThan(out.indexOf('<title>'));
	});

	it('ignores a head tag inside a script', () => {
		const out = injectHtmlRenderBootstrap('<html><script>"<head>"</script><body></body></html>');
		expect(out.startsWith('<html><head><meta charset="utf-8">')).toBe(true);
	});

	it('adds a head to fragments and keeps an existing charset', () => {
		const out = injectHtmlRenderBootstrap('<meta charset="utf-8"><p>x</p>');
		expect(out.startsWith('<!doctype html><head><meta name="viewport"')).toBe(true);
	});
});
