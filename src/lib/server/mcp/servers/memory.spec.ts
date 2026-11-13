import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';
process.env.MEMORY_VOLUME = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-mem-mcp-'));

const { createMemoryServer } = await import('./memory.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { createMCPClient } = await import('@ai-sdk/mcp');

const userCtx = { userId: 'u1', role: 'user', workspaceDir: null, documentsDir: '' };
const adminCtx = { userId: 'admin1', role: 'admin', workspaceDir: null, documentsDir: '' };

type Ctx = typeof userCtx;

async function callTool(ctx: Ctx, name: string, args: Record<string, unknown>) {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const server = createMemoryServer(ctx);
	await server.connect(serverTransport);
	const client = await createMCPClient({ transport: clientTransport, maxRetries: 0 });
	try {
		const tools = await client.tools();
		const tool = tools[name] as unknown as {
			execute: (input: unknown, opts: unknown) => Promise<unknown>;
		};
		return await tool.execute(args, { toolCallId: 't1', messages: [] });
	} finally {
		await client.close();
		await server.close();
	}
}

function resultText(res: unknown): string {
	const r = res as { content?: Array<{ type: string; text?: string }> };
	return r.content?.[0]?.text ?? '';
}

function isError(res: unknown): boolean {
	return (res as { isError?: boolean }).isError === true;
}

describe('memory server round trip', () => {
	it('create → read → list → update → search → delete', async () => {
		const created = await callTool(userCtx, 'create_concept', {
			path: 'projects/rocket.md',
			title: 'Rocket',
			type: 'project',
			description: 'rocket project',
			tags: ['space', 'quixotic'],
			body: 'The rocket runs on chamomile fuel'
		});
		expect(isError(created)).toBe(false);
		expect(resultText(created)).toBe('created projects/rocket.md');

		const read = await callTool(userCtx, 'read_concept', { path: 'projects/rocket.md' });
		expect(isError(read)).toBe(false);
		const concept = JSON.parse(resultText(read)) as {
			path: string;
			scope: string;
			frontmatter: { title: string; type: string; tags: string[] };
			body: string;
		};
		expect(concept.path).toBe('projects/rocket.md');
		expect(concept.scope).toBe('user');
		expect(concept.frontmatter.title).toBe('Rocket');
		expect(concept.frontmatter.type).toBe('project');
		expect(concept.frontmatter.tags).toEqual(['space', 'quixotic']);
		expect(concept.body).toContain('chamomile fuel');

		const listed = await callTool(userCtx, 'list_concepts', {});
		expect(JSON.parse(resultText(listed))).toContainEqual(
			expect.objectContaining({ path: 'projects/rocket.md', title: 'Rocket' })
		);
		const listedPrefix = await callTool(userCtx, 'list_concepts', { prefix: 'projects' });
		expect(
			(JSON.parse(resultText(listedPrefix)) as Array<{ path: string }>).map((c) => c.path)
		).toEqual(['projects/rocket.md']);

		const updated = await callTool(userCtx, 'update_concept', {
			path: 'projects/rocket.md',
			body: 'upgraded chamomile thrusters'
		});
		expect(resultText(updated)).toBe('updated projects/rocket.md');
		const reread = await callTool(userCtx, 'read_concept', { path: 'projects/rocket.md' });
		const rereadConcept = JSON.parse(resultText(reread)) as {
			frontmatter: { title: string; tags: string[] };
			body: string;
		};
		expect(rereadConcept.body).toContain('upgraded chamomile thrusters');
		expect(rereadConcept.frontmatter.title).toBe('Rocket');
		expect(rereadConcept.frontmatter.tags).toEqual(['space', 'quixotic']);

		const byBody = await callTool(userCtx, 'search_memory', { query: 'chamomile' });
		const bodyHits = JSON.parse(resultText(byBody)) as Array<{ path: string; scope: string }>;
		expect(bodyHits.map((h) => h.path)).toContain('projects/rocket.md');
		expect(bodyHits[0].scope).toBe('user:u1');

		const byTag = await callTool(userCtx, 'search_memory', { query: 'quixotic' });
		const tagHits = JSON.parse(resultText(byTag)) as Array<{ path: string }>;
		expect(tagHits.map((h) => h.path)).toContain('projects/rocket.md');

		const deleted = await callTool(userCtx, 'delete_concept', { path: 'projects/rocket.md' });
		expect(resultText(deleted)).toBe('deleted projects/rocket.md');
		const gone = await callTool(userCtx, 'read_concept', { path: 'projects/rocket.md' });
		expect(isError(gone)).toBe(true);
		expect(resultText(gone)).toContain('concept not found');
	});
});

describe('memory server errors', () => {
	it('rejects create on an existing path', async () => {
		await callTool(userCtx, 'create_concept', {
			path: 'dup.md',
			title: 'Dup',
			body: 'first'
		});
		const res = await callTool(userCtx, 'create_concept', {
			path: 'dup.md',
			title: 'Dup',
			body: 'second'
		});
		expect(isError(res)).toBe(true);
		expect(resultText(res)).toContain('concept already exists');
	});

	it('rejects update and delete on a missing concept', async () => {
		const updated = await callTool(userCtx, 'update_concept', {
			path: 'missing.md',
			body: 'x'
		});
		expect(isError(updated)).toBe(true);
		expect(resultText(updated)).toContain('concept not found');
		const deleted = await callTool(userCtx, 'delete_concept', { path: 'missing.md' });
		expect(isError(deleted)).toBe(true);
		expect(resultText(deleted)).toContain('concept not found');
	});

	it('rejects invalid concept paths', async () => {
		for (const tool of ['create_concept', 'read_concept', 'delete_concept']) {
			const args: Record<string, unknown> = { path: '../x.md' };
			if (tool === 'create_concept') Object.assign(args, { title: 'X', body: 'x' });
			const res = await callTool(userCtx, tool, args);
			expect(isError(res)).toBe(true);
			expect(resultText(res)).toContain('invalid concept path');
		}
	});

	it('rejects an empty search query', async () => {
		const res = await callTool(userCtx, 'search_memory', { query: '   ' });
		expect(isError(res)).toBe(true);
	});
});

describe('shared scope', () => {
	it('rejects shared writes for non-admin users', async () => {
		const created = await callTool(userCtx, 'create_concept', {
			path: 'team/values.md',
			title: 'Values',
			body: 'x',
			scope: 'shared'
		});
		expect(isError(created)).toBe(true);
		expect(resultText(created)).toContain('shared bundle requires admin role');

		const updated = await callTool(userCtx, 'update_concept', {
			path: 'team/values.md',
			body: 'x',
			scope: 'shared'
		});
		expect(isError(updated)).toBe(true);
		const deleted = await callTool(userCtx, 'delete_concept', {
			path: 'team/values.md',
			scope: 'shared'
		});
		expect(isError(deleted)).toBe(true);
	});

	it('allows admins to write shared concepts and everyone to read them', async () => {
		const created = await callTool(adminCtx, 'create_concept', {
			path: 'team/values.md',
			title: 'Values',
			tags: ['culture'],
			body: 'shared zelda marker',
			scope: 'shared'
		});
		expect(isError(created)).toBe(false);
		expect(resultText(created)).toBe('created team/values.md');

		const read = await callTool(userCtx, 'read_concept', {
			path: 'team/values.md',
			scope: 'shared'
		});
		expect(isError(read)).toBe(false);
		const concept = JSON.parse(resultText(read)) as { scope: string; body: string };
		expect(concept.scope).toBe('shared');
		expect(concept.body).toContain('shared zelda marker');

		const listed = await callTool(userCtx, 'list_concepts', { scope: 'shared' });
		expect(JSON.parse(resultText(listed))).toContainEqual(
			expect.objectContaining({ path: 'team/values.md' })
		);
	});

	it('search_memory spans user and shared scopes', async () => {
		await callTool(userCtx, 'create_concept', {
			path: 'personal/zelda.md',
			title: 'Zelda',
			body: 'personal zelda notes'
		});
		const res = await callTool(userCtx, 'search_memory', { query: 'zelda' });
		const hits = JSON.parse(resultText(res)) as Array<{ path: string; scope: string }>;
		const byPath = new Map(hits.map((h) => [h.path, h.scope]));
		expect(byPath.get('personal/zelda.md')).toBe('user:u1');
		expect(byPath.get('team/values.md')).toBe('shared');
	});
});

function widgetItem(res: unknown): Record<string, unknown> {
	const r = res as { content?: Array<{ type: string; text?: string }> };
	return JSON.parse(r.content?.[1]?.text ?? 'null') as Record<string, unknown>;
}

describe('memory widget items', () => {
	it('returns a ```memory widget item with each write', async () => {
		const created = await callTool(userCtx, 'create_concept', {
			path: 'people/maria',
			title: 'Maria',
			body: '# Maria\n\nMy **sister**, lives in [[places/valencia.md|Valencia]]. Uses snake_case.'
		});
		expect(widgetItem(created)).toEqual({
			action: 'created',
			path: 'people/maria.md',
			scope: 'user',
			title: 'Maria',
			snippet: 'Maria My sister, lives in Valencia. Uses snake_case.'
		});

		const updated = await callTool(userCtx, 'update_concept', {
			path: 'people/maria.md',
			description: 'Your sister in Valencia'
		});
		expect(widgetItem(updated)).toMatchObject({
			action: 'updated',
			title: 'Maria',
			snippet: 'Your sister in Valencia'
		});

		const deleted = await callTool(userCtx, 'delete_concept', { path: 'people/maria.md' });
		expect(widgetItem(deleted)).toMatchObject({ action: 'deleted', path: 'people/maria.md' });
	});

	it('mentions the fence in the write tool descriptions', async () => {
		const { createMemoryServer: create } = await import('./memory.js');
		const server = create(userCtx) as unknown as {
			_registeredTools: Record<string, { description?: string }>;
		};
		expect(server._registeredTools.create_concept.description).toContain('```memory');
		expect(server._registeredTools.update_concept.description).toContain('```memory');
	});
});

describe('memorySnippet', () => {
	it('prefers the description and truncates long text', async () => {
		const { memorySnippet } = await import('./memory.js');
		expect(memorySnippet(' Short note ', 'body')).toBe('Short note');
		const long = memorySnippet(undefined, 'word '.repeat(80));
		expect(long.length).toBeLessThanOrEqual(160);
		expect(long.endsWith('…')).toBe(true);
	});
});
