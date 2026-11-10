import { beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/index.js';
import { extractionWindowNote, seedBuiltinAgent, seedMemoryCleanupAgent } from './builtin.js';

let db: Db;

beforeAll(() => {
	process.env.APP_SECRET = 'test-secret-test-secret';
	db = openDatabase(':memory:');
});

describe('builtin agent seeds', () => {
	it('seeds the memory-extraction agent idempotently as an every-5th chat.created event agent', () => {
		seedBuiltinAgent(db);
		seedBuiltinAgent(db);
		const rows = db
			.prepare("SELECT * FROM agents WHERE name = 'memory-extraction' AND user_id IS NULL")
			.all() as { trigger_type: string; trigger_config: string; enabled: number }[];
		expect(rows).toHaveLength(1);
		expect(rows[0].trigger_type).toBe('event');
		expect(rows[0].enabled).toBe(1);
		const triggerConfig = JSON.parse(rows[0].trigger_config) as {
			event?: string;
			every?: number;
			instructions?: string;
		};
		expect(triggerConfig.event).toBe('chat.created');
		expect(triggerConfig.every).toBe(5);
		expect(triggerConfig.instructions).toBeTruthy();
	});

	it('migrates a legacy scheduled memory-extraction row to the event trigger', () => {
		db.prepare(
			"UPDATE agents SET trigger_type = 'schedule', trigger_config = '{\"cron\":\"*/15 * * * *\"}', next_run_at = 123 WHERE name = 'memory-extraction'"
		).run();
		seedBuiltinAgent(db);
		const row = db
			.prepare("SELECT * FROM agents WHERE name = 'memory-extraction' AND user_id IS NULL")
			.get() as { trigger_type: string; trigger_config: string; next_run_at: number | null };
		expect(row.trigger_type).toBe('event');
		expect(row.next_run_at).toBeNull();
		const triggerConfig = JSON.parse(row.trigger_config) as { event?: string; every?: number };
		expect(triggerConfig.event).toBe('chat.created');
		expect(triggerConfig.every).toBe(5);
	});

	it('seeds the memory-cleanup agent as an every-5th memory.changed event agent', () => {
		seedMemoryCleanupAgent(db);
		seedMemoryCleanupAgent(db);
		const rows = db
			.prepare("SELECT * FROM agents WHERE name = 'memory-cleanup' AND user_id IS NULL")
			.all() as { trigger_type: string; trigger_config: string; enabled: number }[];
		expect(rows).toHaveLength(1);
		expect(rows[0].trigger_type).toBe('event');
		expect(rows[0].enabled).toBe(1);
		const triggerConfig = JSON.parse(rows[0].trigger_config) as {
			event?: string;
			every?: number;
		};
		expect(triggerConfig.event).toBe('memory.changed');
		expect(triggerConfig.every).toBe(5);
	});
});

describe('extractionWindowNote', () => {
	it('gives the exact ISO time of the last successful extraction', () => {
		const note = extractionWindowNote(Date.UTC(2026, 10, 10, 8, 30));
		expect(note).toContain('since = "2026-11-10T08:30:00.000Z"');
	});

	it('asks for a full review when there was no successful extraction yet', () => {
		expect(extractionWindowNote(null)).toContain('since = 0');
	});
});
