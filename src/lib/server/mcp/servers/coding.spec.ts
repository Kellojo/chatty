import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

const startAgentRun = vi.fn();
vi.doMock('../../agents/runner.js', () => ({ startAgentRun }));
// The coding environment is remote; only these two calls reach it.
const resolveCodingTarget = vi.fn();
const getCodingOptions = vi.fn();
vi.doMock('../../t3/tasks.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../t3/tasks.js')>()),
	resolveCodingTarget,
	getCodingOptions
}));

const { createCodingServer } = await import('./coding.js');
const { getDb } = await import('../../db/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { createMCPClient } = await import('@ai-sdk/mcp');

const ctx = { userId: 'u1', role: 'user', workspaceDir: null, documentsDir: '' };

beforeAll(() => {
	const db = getDb();
	db.prepare(
		'INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role) VALUES (\'u1\', \'a@b.c\', \'A\', 0, 0, 0, \'user\')'
	).run();
	db.prepare(
		'INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role) VALUES (\'u2\', \'d@e.f\', \'D\', 0, 0, 0, \'user\')'
	).run();
});

async function callTool(
	name: string,
	args: Record<string, unknown>,
	callerCtx: Parameters<typeof createCodingServer>[0] = ctx
) {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const server = createCodingServer(callerCtx);
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

function isErr(res: unknown): boolean {
	return (res as { isError?: boolean }).isError === true;
}

describe('propose_coding_task', () => {
	const proposal = { title: 'Fix login', prompt: 'Fix the login redirect.' };

	it('refuses when the user has nowhere to run a coding task', async () => {
		const res = await callTool('propose_coding_task', proposal, { ...ctx, userId: 'u2' });
		expect(isErr(res)).toBe(true);
		expect(resultText(res)).toMatch(/no coding environment/);
	});

	it('only proposes, starting nothing, once the user has a coding environment', async () => {
		const { createCodingEnvironment } = await import('../../db/repo/coding-environments.js');
		createCodingEnvironment(getDb(), 'u1', {
			name: 'devbox',
			baseUrl: 'https://devbox.example',
			token: 'token'
		});
		startAgentRun.mockClear();
		const res = await callTool('propose_coding_task', proposal);
		expect(isErr(res)).toBe(false);
		expect(JSON.parse(resultText(res))).toMatchObject({ proposed: true, title: 'Fix login' });
		expect(startAgentRun).not.toHaveBeenCalled();
	});

	it('refuses inside agent runs, which have no chat to start it from', async () => {
		const res = await callTool('propose_coding_task', proposal, { ...ctx, agentRunId: 'run-1' });
		expect(isErr(res)).toBe(true);
	});

	it('checks a named project and returns it for the card', async () => {
		resolveCodingTarget.mockResolvedValueOnce({
			env: { id: 'env-1', name: 'devbox' },
			project: { id: 'p-1', title: 'ai-chat' }
		});
		const res = await callTool('propose_coding_task', {
			...proposal,
			environmentId: 'env-1',
			projectId: 'p-1'
		});
		expect(isErr(res)).toBe(false);
		expect(resolveCodingTarget).toHaveBeenCalledWith(
			'u1',
			{ environmentId: 'env-1', projectId: 'p-1', workspaceMode: 'local' },
			expect.anything()
		);
		expect(JSON.parse(resultText(res)).target).toEqual({
			environmentId: 'env-1',
			environmentName: 'devbox',
			projectId: 'p-1',
			projectTitle: 'ai-chat'
		});
	});

	it('refuses an unknown project, and half a target', async () => {
		resolveCodingTarget.mockRejectedValueOnce(new Error('Project not found on this environment'));
		const unknown = await callTool('propose_coding_task', {
			...proposal,
			environmentId: 'env-1',
			projectId: 'nope'
		});
		expect(isErr(unknown)).toBe(true);
		expect(resultText(unknown)).toMatch(/Project not found.*list_coding_projects/);
		const half = await callTool('propose_coding_task', { ...proposal, projectId: 'p-1' });
		expect(isErr(half)).toBe(true);
	});
});

describe('list_coding_projects', () => {
	it("lists each enabled environment's projects, reporting unreachable ones", async () => {
		const { createCodingEnvironment } = await import('../../db/repo/coding-environments.js');
		const db = getDb();
		const second = createCodingEnvironment(db, 'u1', {
			name: 'laptop',
			baseUrl: 'https://laptop.example',
			token: 'token'
		});
		getCodingOptions.mockImplementation(async (_userId: string, envId: string) => {
			if (envId === second.id) throw new Error('Could not reach the coding environment');
			return {
				projects: [
					{
						id: 'p-1',
						title: 'ai-chat',
						isGitRepo: true,
						defaultBranch: 'main',
						defaultModel: null,
						defaultAutonomy: null,
						defaultWorkspaceMode: null
					}
				]
			};
		});
		const res = await callTool('list_coding_projects', {});
		const body = JSON.parse(resultText(res)) as Record<string, unknown>[];
		expect(body).toContainEqual(
			expect.objectContaining({
				environmentName: 'devbox',
				projects: [{ projectId: 'p-1', title: 'ai-chat', isGitRepo: true, defaultBranch: 'main' }]
			})
		);
		expect(body).toContainEqual(
			expect.objectContaining({
				environmentName: 'laptop',
				error: 'Could not reach the coding environment'
			})
		);
	});

	it('refuses when the user has no coding environment', async () => {
		const res = await callTool('list_coding_projects', {}, { ...ctx, userId: 'u2' });
		expect(isErr(res)).toBe(true);
	});
});
