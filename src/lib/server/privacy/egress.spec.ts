import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

process.env.DATABASE_PATH = ':memory:';
process.env.MEMORY_VOLUME = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-egress-'));

const { closeDb, getDb } = await import('../db/index.js');
const { BUILTIN_SERVERS } = await import('../mcp/servers/index.js');
const { TOOL_EGRESS, toolEgress } = await import('./egress.js');
const { seedPrivacyFixture, setRole } = await import('./fixtures.js');

type Registered = { _registeredTools: Record<string, unknown> };

/** Every tool each builtin server registers, as `server/tool`. */
function builtinToolKeys(): string[] {
	const ctx = { userId: 'u1', role: 'admin', workspaceDir: null, documentsDir: os.tmpdir() };
	return Object.entries(BUILTIN_SERVERS).flatMap(([name, factory]) =>
		Object.keys((factory(ctx) as unknown as Registered)._registeredTools).map((t) => `${name}/${t}`)
	);
}

beforeEach(() => {
	closeDb();
});

describe('TOOL_EGRESS', () => {
	it('classifies every builtin tool', () => {
		seedPrivacyFixture(getDb());
		const missing = builtinToolKeys().filter((key) => !(key in TOOL_EGRESS));
		expect(missing).toEqual([]);
	});

	it('lists no tool that no longer exists', () => {
		seedPrivacyFixture(getDb());
		const known = new Set(builtinToolKeys());
		expect(Object.keys(TOOL_EGRESS).filter((key) => !known.has(key))).toEqual([]);
	});

	it('fails closed for unknown tools and untrusted external servers', () => {
		const db = getDb();
		expect(toolEgress(db, { name: 'webfetch', builtin: 1 }, 'something_new')).toBe('egress');
		expect(toolEgress(db, { name: 'groceries', builtin: 0, allow_private: 0 }, 'add')).toBe(
			'egress'
		);
		expect(toolEgress(db, { name: 'groceries', builtin: 0, allow_private: 1 }, 'add')).toBe('none');
		// A server named like a builtin is still external.
		expect(toolEgress(db, { name: 'math', builtin: 0 }, 'calculate')).toBe('egress');
	});

	it("follows the role's provider for image and speech tools", () => {
		const db = getDb();
		const fx = seedPrivacyFixture(db);
		const image = { name: 'image', builtin: 1 };
		expect(toolEgress(db, image, 'generate_image')).toBe('egress');
		setRole(db, 'image', fx.untrusted);
		expect(toolEgress(db, image, 'generate_image')).toBe('egress');
		setRole(db, 'image', fx.trusted);
		expect(toolEgress(db, image, 'generate_image')).toBe('none');
		setRole(db, 'speech-to-text', fx.trusted);
		expect(toolEgress(db, { name: 'speech', builtin: 1 }, 'transcribe_audio')).toBe('none');
	});
});
