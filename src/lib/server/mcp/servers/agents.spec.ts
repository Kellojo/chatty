import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

const startAgentRun = vi.fn();
vi.doMock('../../agents/runner.js', () => ({ startAgentRun }));

const { createAgentsServer } = await import('./agents.js');
const { getDb } = await import('../../db/index.js');
const { createAgent } = await import('../../db/repo/agents.js');
const { createAgentRun, finishAgentRun } = await import('../../db/repo/agent-runs.js');
const { createConversation } = await import('../../db/repo/conversations.js');
const { createMessage } = await import('../../db/repo/messages.js');
const { publishServerEvent } = await import('../../events/bus.js');
const { waitForRunToSettle } = await import('../../agents/run-result.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { createMCPClient } = await import('@ai-sdk/mcp');

const ctx = { userId: 'u1', role: 'user', workspaceDir: null, documentsDir: '' };

let ownId: string;
let builtinId: string;
let otherId: string;

beforeAll(() => {
	const db = getDb();
	db.prepare(
		'INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role) VALUES (\'u1\', \'a@b.c\', \'A\', 0, 0, 0, \'user\')'
	).run();
	db.prepare(
		'INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role) VALUES (\'u2\', \'d@e.f\', \'D\', 0, 0, 0, \'user\')'
	).run();
	ownId = createAgent(db, 'u1', {
		name: 'my agent',
		description: 'mine',
		systemPrompt: 'do stuff',
		triggerType: 'manual'
	}).id;
	builtinId = createAgent(db, null, {
		name: 'builtin agent',
		systemPrompt: 'built in',
		triggerType: 'manual'
	}).id;
	otherId = createAgent(db, 'u2', {
		name: 'other agent',
		systemPrompt: 'not yours',
		triggerType: 'manual'
	}).id;
});

async function callTool(
	name: string,
	args: Record<string, unknown>,
	callerCtx: Parameters<typeof createAgentsServer>[0] = ctx
) {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const server = createAgentsServer(callerCtx);
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

describe('list_agents', () => {
	it("lists own and built-in agents, not other users'", async () => {
		const res = await callTool('list_agents', {});
		expect(isErr(res)).toBe(false);
		const agents = JSON.parse(resultText(res)) as Array<{
			id: string;
			name: string;
			builtin: boolean;
		}>;
		const ids = new Set(agents.map((a) => a.id));
		expect(ids.has(ownId)).toBe(true);
		expect(ids.has(builtinId)).toBe(true);
		expect(ids.has(otherId)).toBe(false);
		const own = agents.find((a) => a.id === ownId)!;
		expect(own.builtin).toBe(false);
		const builtin = agents.find((a) => a.id === builtinId)!;
		expect(builtin.builtin).toBe(true);
	});
});

describe('get_agent', () => {
	it('returns own agent with full config', async () => {
		const res = await callTool('get_agent', { agentId: ownId });
		expect(isErr(res)).toBe(false);
		const agent = JSON.parse(resultText(res)) as {
			id: string;
			name: string;
			systemPrompt: string;
			triggerType: string;
		};
		expect(agent.id).toBe(ownId);
		expect(agent.name).toBe('my agent');
		expect(agent.systemPrompt).toBe('do stuff');
		expect(agent.triggerType).toBe('manual');
	});

	it('returns built-in agents', async () => {
		const res = await callTool('get_agent', { agentId: builtinId });
		expect(isErr(res)).toBe(false);
	});

	it("rejects another user's agent", async () => {
		const res = await callTool('get_agent', { agentId: otherId });
		expect(isErr(res)).toBe(true);
		expect(resultText(res)).toContain('agent not found');
	});

	it('rejects an unknown id', async () => {
		const res = await callTool('get_agent', { agentId: 'nope' });
		expect(isErr(res)).toBe(true);
	});
});

describe('create_agent', () => {
	it('creates an agent with defaults', async () => {
		const res = await callTool('create_agent', {
			name: 'new agent',
			systemPrompt: 'you are helpful',
			triggerType: 'manual'
		});
		expect(isErr(res)).toBe(false);
		const agent = JSON.parse(resultText(res)) as {
			name: string;
			userId: string;
			enabled: boolean;
			triggerType: string;
		};
		expect(agent.name).toBe('new agent');
		expect(agent.userId).toBe('u1');
		expect(agent.enabled).toBe(true);
		expect(agent.triggerType).toBe('manual');
	});

	it('creates a schedule agent with nextRunAt', async () => {
		const res = await callTool('create_agent', {
			name: 'cron agent',
			systemPrompt: 'run daily',
			triggerType: 'schedule',
			triggerConfig: { cron: '0 9 * * *' }
		});
		expect(isErr(res)).toBe(false);
		const agent = JSON.parse(resultText(res)) as {
			triggerType: string;
			triggerConfig: { cron: string };
			nextRunAt: number | null;
		};
		expect(agent.triggerType).toBe('schedule');
		expect(agent.triggerConfig.cron).toBe('0 9 * * *');
		expect(agent.nextRunAt).toBeGreaterThan(Date.now());
	});

	it('rejects schedule without cron', async () => {
		const res = await callTool('create_agent', {
			name: 'bad',
			systemPrompt: 'x',
			triggerType: 'schedule'
		});
		expect(isErr(res)).toBe(true);
		expect(resultText(res)).toContain('cron expression');
	});

	it('rejects invalid cron', async () => {
		const res = await callTool('create_agent', {
			name: 'bad',
			systemPrompt: 'x',
			triggerType: 'schedule',
			triggerConfig: { cron: 'not a cron' }
		});
		expect(isErr(res)).toBe(true);
		expect(resultText(res)).toContain('Invalid cron');
	});

	it('rejects event without event name', async () => {
		const res = await callTool('create_agent', {
			name: 'bad',
			systemPrompt: 'x',
			triggerType: 'event'
		});
		expect(isErr(res)).toBe(true);
		expect(resultText(res)).toContain('event name');
	});

	it('rejects providerId without modelId', async () => {
		const res = await callTool('create_agent', {
			name: 'bad',
			systemPrompt: 'x',
			triggerType: 'manual',
			providerId: 'p1'
		});
		expect(isErr(res)).toBe(true);
		expect(resultText(res)).toContain('providerId and modelId');
	});

	it('rejects an unknown model like the REST API', async () => {
		const res = await callTool('create_agent', {
			name: 'bad',
			systemPrompt: 'x',
			triggerType: 'manual',
			providerId: 'p1',
			modelId: 'does-not-exist'
		});
		expect(isErr(res)).toBe(true);
		expect(resultText(res)).toContain('Unknown model');
	});

	it('rejects out-of-range maxSteps like the REST API', async () => {
		const res = await callTool('create_agent', {
			name: 'bad',
			systemPrompt: 'x',
			triggerType: 'manual',
			maxSteps: 1000
		});
		expect(isErr(res)).toBe(true);
	});
});

describe('update_agent', () => {
	it('patches name and systemPrompt', async () => {
		const res = await callTool('update_agent', {
			agentId: ownId,
			name: 'renamed',
			systemPrompt: 'new prompt'
		});
		expect(isErr(res)).toBe(false);
		const agent = JSON.parse(resultText(res)) as { name: string; systemPrompt: string };
		expect(agent.name).toBe('renamed');
		expect(agent.systemPrompt).toBe('new prompt');
	});

	it('rejects modifying built-in agents', async () => {
		const res = await callTool('update_agent', { agentId: builtinId, name: 'hacked' });
		expect(isErr(res)).toBe(true);
		expect(resultText(res)).toContain('built-in agents cannot be modified');
	});

	it('rejects changing coding agents', async () => {
		const codingId = createAgent(getDb(), 'u1', {
			name: 'coder',
			systemPrompt: 'update deps',
			triggerType: 'manual',
			codingTarget: {
				environmentId: 'e',
				projectId: 'p',
				projectTitle: 'P',
				providerInstanceId: 'codex',
				model: 'm',
				autonomy: 'supervised',
				workspaceMode: 'local',
				baseBranch: null
			}
		}).id;
		const res = await callTool('update_agent', { agentId: codingId, systemPrompt: 'other work' });
		expect(isErr(res)).toBe(true);
		expect(resultText(res)).toContain('coding agents can only be changed by the user');
	});

	it('cannot turn an agent into a coding agent', async () => {
		await callTool('update_agent', {
			agentId: ownId,
			codingTarget: { environmentId: 'e', projectId: 'p' }
		});
		const row = getDb().prepare('SELECT coding_target FROM agents WHERE id = ?').get(ownId) as {
			coding_target: string | null;
		};
		expect(row.coding_target).toBeNull();
	});

	it("rejects another user's agent", async () => {
		const res = await callTool('update_agent', { agentId: otherId, name: 'hacked' });
		expect(isErr(res)).toBe(true);
	});

	it('rejects changing to schedule without cron', async () => {
		const res = await callTool('update_agent', { agentId: ownId, triggerType: 'schedule' });
		expect(isErr(res)).toBe(true);
		expect(resultText(res)).toContain('cron expression');
	});

	it('rejects an invalid cron on update', async () => {
		const res = await callTool('update_agent', {
			agentId: ownId,
			triggerType: 'schedule',
			triggerConfig: { cron: 'not a cron' }
		});
		expect(isErr(res)).toBe(true);
		expect(resultText(res)).toContain('Invalid cron');
	});

	it('rejects an unknown model on update', async () => {
		const res = await callTool('update_agent', {
			agentId: ownId,
			providerId: 'p1',
			modelId: 'does-not-exist'
		});
		expect(isErr(res)).toBe(true);
		expect(resultText(res)).toContain('Unknown model');
	});

	it('updates nextRunAt when enabling a schedule agent', async () => {
		const created = await callTool('create_agent', {
			name: 'toggle cron',
			systemPrompt: 'x',
			triggerType: 'schedule',
			triggerConfig: { cron: '0 8 * * *' },
			enabled: false
		});
		const createdAgent = JSON.parse(resultText(created)) as { id: string; nextRunAt: null };
		expect(createdAgent.nextRunAt).toBeNull();
		const updated = await callTool('update_agent', { agentId: createdAgent.id, enabled: true });
		expect(isErr(updated)).toBe(false);
		const agent = JSON.parse(resultText(updated)) as { enabled: boolean; nextRunAt: number | null };
		expect(agent.enabled).toBe(true);
		expect(agent.nextRunAt).toBeGreaterThan(Date.now());
	});
});

describe('delete_agent', () => {
	it('deletes own agent', async () => {
		const created = await callTool('create_agent', {
			name: 'to delete',
			systemPrompt: 'x',
			triggerType: 'manual'
		});
		const agent = JSON.parse(resultText(created)) as { id: string };
		const res = await callTool('delete_agent', { agentId: agent.id });
		expect(isErr(res)).toBe(false);
		expect(resultText(res)).toContain('deleted');
		const gone = await callTool('get_agent', { agentId: agent.id });
		expect(isErr(gone)).toBe(true);
	});

	it('rejects deleting built-in agents', async () => {
		const res = await callTool('delete_agent', { agentId: builtinId });
		expect(isErr(res)).toBe(true);
		expect(resultText(res)).toContain('built-in agents cannot be deleted');
	});

	it("rejects deleting another user's agent", async () => {
		const res = await callTool('delete_agent', { agentId: otherId });
		expect(isErr(res)).toBe(true);
	});
});

describe('start_agent', () => {
	function fakeRun(agentId: string, status = 'running') {
		const db = getDb();
		const run = createAgentRun(db, { agentId, userId: 'u1', trigger: 'manual' });
		db.prepare('UPDATE agent_runs SET status = ? WHERE id = ?').run(status, run.id);
		return { ...run, status };
	}

	beforeEach(() => {
		startAgentRun.mockReset();
		startAgentRun.mockImplementation(async (input: { agentId: string }) => {
			const run = fakeRun(input.agentId, 'success');
			return { run: { ...run, status: 'running' }, done: Promise.resolve(run) };
		});
	});

	function newAgent(extra: Record<string, unknown> = {}) {
		return createAgent(getDb(), 'u1', {
			name: 'runnable',
			systemPrompt: 'x',
			triggerType: 'manual',
			...extra
		}).id;
	}

	it('starts an own agent with instructions and returns the run', async () => {
		const id = newAgent();
		const res = await callTool('start_agent', { agentId: id, instructions: '  sort my inbox ' });
		expect(isErr(res)).toBe(false);
		expect(startAgentRun).toHaveBeenCalledWith({
			agentId: id,
			trigger: 'manual',
			userId: 'u1',
			instructions: 'sort my inbox'
		});
		const body = JSON.parse(resultText(res)) as {
			run: { agentId: string; status: string; id: string };
			runPath: string;
		};
		expect(body.run.agentId).toBe(id);
		expect(body.run.status).toBe('running');
		expect(body.runPath).toBe(`/agents/${id}/runs/${body.run.id}`);
	});

	it("rejects built-in and other users' agents", async () => {
		const builtin = await callTool('start_agent', { agentId: builtinId });
		expect(isErr(builtin)).toBe(true);
		expect(resultText(builtin)).toContain('built-in agents');
		const other = await callTool('start_agent', { agentId: otherId });
		expect(isErr(other)).toBe(true);
		expect(resultText(other)).toContain('agent not found');
		expect(startAgentRun).not.toHaveBeenCalled();
	});

	it('rejects an agent that is already running', async () => {
		const id = newAgent();
		fakeRun(id, 'running');
		const res = await callTool('start_agent', { agentId: id });
		expect(isErr(res)).toBe(true);
		expect(resultText(res)).toContain('already running');
		expect(startAgentRun).not.toHaveBeenCalled();
	});

	it('does not let an agent run start its own agent', async () => {
		const id = newAgent();
		const run = fakeRun(id, 'success');
		const res = await callTool('start_agent', { agentId: id }, { ...ctx, agentRunId: run.id });
		expect(isErr(res)).toBe(true);
		expect(resultText(res)).toContain('cannot start itself');
	});

	it('starts coding agents only with their saved task', async () => {
		const id = newAgent({
			codingTarget: {
				environmentId: 'e',
				projectId: 'p',
				projectTitle: 'P',
				providerInstanceId: 'codex',
				model: 'm',
				autonomy: 'supervised',
				workspaceMode: 'local',
				baseBranch: null
			}
		});
		const withTask = await callTool('start_agent', { agentId: id, instructions: 'rm -rf' });
		expect(isErr(withTask)).toBe(true);
		expect(resultText(withTask)).toContain('saved task');
		const saved = await callTool('start_agent', { agentId: id });
		expect(isErr(saved)).toBe(false);
		expect(startAgentRun).toHaveBeenCalledTimes(1);
	});

	it('names the agent and links the run without waiting', async () => {
		const id = newAgent();
		const body = JSON.parse(resultText(await callTool('start_agent', { agentId: id })));
		expect(body.agent).toEqual({ id, name: 'runnable' });
		expect(body.run.status).toBe('running');
		expect(body.result).toBeNull();
		expect(body.note).toContain('get_agent_run');
	});

	describe('with wait', () => {
		/** A run that is still going, with a conversation for its reply. */
		function liveRun(agentId: string) {
			const db = getDb();
			const conversation = createConversation(db, 'u1', { kind: 'agent-run', agentId });
			const ref: { id: string } = { id: '' };
			startAgentRun.mockImplementationOnce(async () => {
				const run = createAgentRun(db, {
					agentId,
					userId: 'u1',
					trigger: 'manual',
					conversationId: conversation.id
				});
				ref.id = run.id;
				return { run, done: Promise.resolve(run) };
			});
			return { run: ref, conversationId: conversation.id };
		}

		function finish(
			runId: string,
			agentId: string,
			conversationId: string,
			parts: unknown[],
			status: 'success' | 'awaiting_input' = 'success'
		) {
			const db = getDb();
			createMessage(db, { conversationId, role: 'assistant', parts });
			finishAgentRun(db, runId, status, null);
			publishServerEvent('u1', { type: 'agent.run.finished', agentId, runId, status });
		}

		it('returns once the run has finished, with its reply', async () => {
			const id = newAgent();
			const { run, conversationId } = liveRun(id);
			const pending = callTool('start_agent', { agentId: id, wait: true });
			// The call blocks until the run settles.
			await new Promise((r) => setTimeout(r, 20));
			finish(run.id, id, conversationId, [
				{ type: 'reasoning', text: 'hidden' },
				{ type: 'text', text: 'Planned 5 dinners.' }
			]);
			const body = JSON.parse(resultText(await pending));
			expect(body.run.status).toBe('success');
			expect(body.result).toBe('Planned 5 dinners.');
			expect(body.question).toBeNull();
		});

		it('hands back the question a run stopped on, with the chat to answer it in', async () => {
			const id = newAgent({ canAsk: 'any' });
			const { run, conversationId } = liveRun(id);
			const pending = callTool('start_agent', { agentId: id, wait: true });
			await new Promise((r) => setTimeout(r, 20));
			finish(
				run.id,
				id,
				conversationId,
				[
					{
						type: 'tool-ask_user',
						toolCallId: 'q1',
						state: 'input-available',
						input: { question: 'Vegetarian this week?', kind: 'confirm' }
					}
				],
				'awaiting_input'
			);
			const body = JSON.parse(resultText(await pending));
			expect(body.run.status).toBe('awaiting_input');
			expect(body.question).toBe('Vegetarian this week?');
			expect(body.chatPath).toBe(`/chat/${conversationId}`);
		});

		it('returns a run that already finished without waiting', async () => {
			const res = await callTool('start_agent', { agentId: newAgent(), wait: true });
			expect(JSON.parse(resultText(res)).run.status).toBe('success');
		});
	});

	it('reports a start failure as a tool error', async () => {
		startAgentRun.mockRejectedValueOnce(new Error('Agent has no model configured'));
		const res = await callTool('start_agent', { agentId: newAgent() });
		expect(isErr(res)).toBe(true);
		expect(resultText(res)).toContain('no model configured');
	});
});

describe('get_agent_run', () => {
	it("returns an own run, not another user's", async () => {
		const db = getDb();
		const run = createAgentRun(db, { agentId: ownId, userId: 'u1', trigger: 'manual' });
		const own = await callTool('get_agent_run', { runId: run.id });
		expect(isErr(own)).toBe(false);
		expect(JSON.parse(resultText(own)).run.id).toBe(run.id);

		const theirs = createAgentRun(db, { agentId: otherId, userId: 'u2', trigger: 'manual' });
		const res = await callTool('get_agent_run', { runId: theirs.id });
		expect(isErr(res)).toBe(true);
		expect(resultText(res)).toContain('agent run not found');
	});
});

describe('waitForRunToSettle', () => {
	it('gives up after the timeout and when the call is aborted', async () => {
		const db = getDb();
		const run = createAgentRun(db, { agentId: ownId, userId: 'u1', trigger: 'manual' });
		expect((await waitForRunToSettle(db, run, { timeoutMs: 10 })).status).toBe('running');

		const controller = new AbortController();
		const pending = waitForRunToSettle(db, run, { timeoutMs: 60_000, signal: controller.signal });
		controller.abort();
		expect((await pending).status).toBe('running');
	});
});

describe('agent card payload', () => {
	it('adds the model display name the ```agent card shows', async () => {
		const db = getDb();
		const { createProvider } = await import('../../db/repo/providers.js');
		const { createModel } = await import('../../db/repo/models.js');
		const provider = createProvider(db, { name: 'P', type: 'openai-compatible' });
		createModel(db, { providerId: provider.id, modelId: 'm-1', displayName: 'Model One' });
		const id = createAgent(db, 'u1', {
			name: 'card agent',
			systemPrompt: 'x',
			triggerType: 'manual',
			providerId: provider.id,
			modelId: 'm-1'
		}).id;

		const withModel = JSON.parse(resultText(await callTool('get_agent', { agentId: id })));
		expect(withModel.modelName).toBe('Model One');
		const noModel = JSON.parse(resultText(await callTool('get_agent', { agentId: ownId })));
		expect(noModel.modelName).toBeNull();
	});

	it('tells the model about the ```agent fence', async () => {
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const server = createAgentsServer(ctx);
		await server.connect(serverTransport);
		const client = await createMCPClient({ transport: clientTransport, maxRetries: 0 });
		try {
			const tools = (await client.tools()) as Record<string, { description?: string }>;
			for (const name of ['get_agent', 'create_agent', 'update_agent']) {
				expect(tools[name].description).toContain('```agent');
			}
		} finally {
			await client.close();
			await server.close();
		}
	});
});
