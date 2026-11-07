import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

const { openDatabase } = await import('./db/index.js');
const { createAgent } = await import('./db/repo/agents.js');
const { createProvider } = await import('./db/repo/providers.js');
const { createModel } = await import('./db/repo/models.js');
const { agentCreateSchema, agentPatchSchema, prepareAgentCreate, prepareAgentUpdate } =
	await import('./agentInput.js');

type Db = ReturnType<typeof openDatabase>;

let db: Db;
let providerId: string;

beforeEach(() => {
	db = openDatabase(':memory:');
	db.prepare(
		`INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt", role)
		 VALUES ('u1', 'a@b.c', 'A', 0, 0, 0, 'user')`
	).run();
	providerId = createProvider(db, { name: 'p', type: 'openai-compatible' }).id;
	createModel(db, { providerId, modelId: 'known-model' });
});

const base = { name: 'a', systemPrompt: 'x' };

describe('agentCreateSchema', () => {
	it('enforces limits on max steps, skills and tool allowlist', () => {
		expect(
			agentCreateSchema.safeParse({ ...base, triggerType: 'manual', maxSteps: 0 }).success
		).toBe(false);
		expect(
			agentCreateSchema.safeParse({ ...base, triggerType: 'manual', maxSteps: 101 }).success
		).toBe(false);
		expect(
			agentCreateSchema.safeParse({
				...base,
				triggerType: 'manual',
				skillNames: Array.from({ length: 51 }, (_, i) => `s${i}`)
			}).success
		).toBe(false);
		expect(
			agentCreateSchema.safeParse({
				...base,
				triggerType: 'manual',
				toolAllowlist: Array.from({ length: 201 }, (_, i) => `t${i}`)
			}).success
		).toBe(false);
		expect(
			agentCreateSchema.safeParse({ ...base, triggerType: 'manual', maxSteps: 10 }).success
		).toBe(true);
	});

	it('rejects blank names and unknown trigger types', () => {
		expect(
			agentCreateSchema.safeParse({ ...base, name: '  ', triggerType: 'manual' }).success
		).toBe(false);
		expect(agentCreateSchema.safeParse({ ...base, triggerType: 'webhook' }).success).toBe(false);
		expect(agentPatchSchema.safeParse({ triggerConfig: { every: 0 } }).success).toBe(false);
	});
});

describe('coding agents', () => {
	const codingTarget = {
		environmentId: 'e',
		projectId: 'p',
		providerInstanceId: 'codex',
		model: 'm',
		autonomy: 'supervised' as const,
		workspaceMode: 'local' as const
	};

	it('keeps coding agents out of chat personas', () => {
		expect(prepareAgentCreate(db, { ...base, triggerType: 'persona', codingTarget })).toEqual({
			ok: false,
			error: 'Coding agents cannot be chat personas'
		});
		const ok = prepareAgentCreate(db, { ...base, triggerType: 'manual', codingTarget });
		expect(ok.ok).toBe(true);
		// The route resolves the target against the environment; it is never passed through.
		expect(ok.ok && 'codingTarget' in ok.value).toBe(false);
	});

	it('rejects switching a coding agent to a persona', () => {
		const agent = createAgent(db, 'u1', {
			...base,
			triggerType: 'manual',
			codingTarget: { ...codingTarget, projectTitle: 'P', baseBranch: null }
		});
		expect(prepareAgentUpdate(db, agent, { triggerType: 'persona' }).ok).toBe(false);
		expect(prepareAgentUpdate(db, agent, { triggerType: 'persona', codingTarget: null }).ok).toBe(
			true
		);
	});
});

describe('prepareAgentCreate', () => {
	it('validates schedule triggers and computes nextRunAt', () => {
		expect(prepareAgentCreate(db, { ...base, triggerType: 'schedule' })).toEqual({
			ok: false,
			error: 'Schedule trigger requires a cron expression'
		});
		expect(
			prepareAgentCreate(db, { ...base, triggerType: 'schedule', triggerConfig: { cron: 'nope' } })
		).toEqual({ ok: false, error: 'Invalid cron expression' });
		const ok = prepareAgentCreate(db, {
			...base,
			triggerType: 'schedule',
			triggerConfig: { cron: '*/5 * * * *' }
		});
		expect(ok.ok && ok.value.nextRunAt).toBeGreaterThan(Date.now());
		const disabled = prepareAgentCreate(db, {
			...base,
			triggerType: 'schedule',
			triggerConfig: { cron: '*/5 * * * *' },
			enabled: false
		});
		expect(disabled.ok && disabled.value.nextRunAt).toBeNull();
	});

	it('requires an event name for event triggers', () => {
		expect(prepareAgentCreate(db, { ...base, triggerType: 'event' })).toEqual({
			ok: false,
			error: 'Event trigger requires an event name'
		});
	});

	it('requires providerId and modelId together and checks the model exists', () => {
		expect(prepareAgentCreate(db, { ...base, triggerType: 'manual', providerId })).toEqual({
			ok: false,
			error: 'providerId and modelId must be provided together'
		});
		expect(
			prepareAgentCreate(db, { ...base, triggerType: 'manual', providerId, modelId: 'missing' })
		).toEqual({ ok: false, error: 'Unknown model' });
		expect(
			prepareAgentCreate(db, { ...base, triggerType: 'manual', providerId, modelId: 'known-model' })
				.ok
		).toBe(true);
	});
});

describe('prepareAgentUpdate', () => {
	function manualAgent() {
		return createAgent(db, 'u1', { ...base, triggerType: 'manual' });
	}

	it('rejects switching to schedule without a valid cron', () => {
		const agent = manualAgent();
		expect(prepareAgentUpdate(db, agent, { triggerType: 'schedule' }).ok).toBe(false);
		expect(
			prepareAgentUpdate(db, agent, { triggerType: 'schedule', triggerConfig: { cron: 'bad' } })
		).toEqual({ ok: false, error: 'Invalid cron expression' });
	});

	it('validates the stored trigger config, replacing or merging per option', () => {
		const agent = createAgent(db, 'u1', {
			...base,
			triggerType: 'schedule',
			triggerConfig: { cron: '*/5 * * * *' }
		});
		// Replacing the config drops the cron, so the schedule becomes invalid.
		expect(prepareAgentUpdate(db, agent, { triggerConfig: { instructions: 'hi' } }).ok).toBe(false);
		const merged = prepareAgentUpdate(
			db,
			agent,
			{ triggerConfig: { instructions: 'hi' } },
			{ mergeTriggerConfig: true }
		);
		expect(merged.ok && merged.value.triggerConfig).toEqual({
			cron: '*/5 * * * *',
			instructions: 'hi'
		});
		expect(merged.ok && merged.value.nextRunAt).toBeGreaterThan(Date.now());
	});

	it('recomputes nextRunAt only when trigger or enabled state changes', () => {
		const agent = createAgent(db, 'u1', {
			...base,
			triggerType: 'schedule',
			triggerConfig: { cron: '*/5 * * * *' },
			enabled: false
		});
		const rename = prepareAgentUpdate(db, agent, { name: 'b' });
		expect(rename.ok && 'nextRunAt' in rename.value).toBe(false);
		const enable = prepareAgentUpdate(db, agent, { enabled: true });
		expect(enable.ok && enable.value.nextRunAt).toBeGreaterThan(Date.now());
	});

	it('checks the resulting provider/model pair', () => {
		const agent = manualAgent();
		expect(prepareAgentUpdate(db, agent, { modelId: 'known-model' })).toEqual({
			ok: false,
			error: 'providerId and modelId must be provided together'
		});
		expect(prepareAgentUpdate(db, agent, { providerId, modelId: 'missing' })).toEqual({
			ok: false,
			error: 'Unknown model'
		});
		expect(prepareAgentUpdate(db, agent, { providerId, modelId: 'known-model' }).ok).toBe(true);
		const withModel = createAgent(db, 'u1', {
			...base,
			triggerType: 'manual',
			providerId,
			modelId: 'known-model'
		});
		expect(prepareAgentUpdate(db, withModel, { modelId: 'missing' })).toEqual({
			ok: false,
			error: 'Unknown model'
		});
		expect(prepareAgentUpdate(db, withModel, { providerId: null, modelId: null }).ok).toBe(true);
	});
});
