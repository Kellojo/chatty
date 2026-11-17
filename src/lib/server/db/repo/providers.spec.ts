import { beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../index.js';
import { createProvider, getProvider, toPublic, updateProvider } from './providers.js';
import { decryptSecret } from '../../crypto.js';

let db: Db;

beforeAll(() => {
	process.env.APP_SECRET = 'test-secret-test-secret';
	db = openDatabase(':memory:');
});

describe('providers repo', () => {
	it('creates and reads back a provider with an encrypted key', () => {
		const p = createProvider(db, {
			name: 'Test',
			type: 'openai-compatible',
			baseUrl: 'http://localhost:1234/v1',
			apiKey: 'sk-secret'
		});
		const stored = getProvider(db, p.id)!;
		expect(stored.api_key_enc).not.toBe('sk-secret');
		expect(decryptSecret(stored.api_key_enc!)).toBe('sk-secret');
		const pub = toPublic(stored);
		expect(pub.hasApiKey).toBe(true);
		expect(JSON.stringify(pub)).not.toContain('sk-secret');
	});

	it('re-encrypts the key on update, preserves on undefined, clears on null', () => {
		const p = createProvider(db, { name: 'Keys', type: 'anthropic', apiKey: 'first' });
		const originalBlob = getProvider(db, p.id)!.api_key_enc!;

		const renamed = updateProvider(db, p.id, { name: 'Keys 2' })!;
		expect(renamed.api_key_enc).toBe(originalBlob);

		const rotated = updateProvider(db, p.id, { apiKey: 'second' })!;
		expect(rotated.api_key_enc).not.toBe(originalBlob);
		expect(decryptSecret(rotated.api_key_enc!)).toBe('second');

		const cleared = updateProvider(db, p.id, { apiKey: null })!;
		expect(cleared.api_key_enc).toBeNull();
	});

	it('delete cascades to models', () => {
		const p = createProvider(db, { name: 'Cascade', type: 'anthropic' });
		db.prepare(
			"INSERT INTO models (id, provider_id, model_id, display_name) VALUES ('m-c', ?, 'x', 'x')"
		).run(p.id);
		db.prepare('DELETE FROM providers WHERE id = ?').run(p.id);
		expect(db.prepare("SELECT * FROM models WHERE id = 'm-c'").get()).toBeUndefined();
	});
	it('is untrusted with private data unless allowPrivate is set, and update toggles it', () => {
		const plain = createProvider(db, { name: 'Plain', type: 'anthropic' });
		expect(plain.allow_private).toBe(0);
		expect(toPublic(plain).allowPrivate).toBe(false);

		const trusted = createProvider(db, {
			name: 'Local',
			type: 'openai-compatible',
			baseUrl: 'http://localhost:1234/v1',
			allowPrivate: true
		});
		expect(trusted.allow_private).toBe(1);
		expect(toPublic(trusted).allowPrivate).toBe(true);

		expect(updateProvider(db, plain.id, { allowPrivate: true })!.allow_private).toBe(1);
		expect(updateProvider(db, plain.id, { name: 'Renamed' })!.allow_private).toBe(1);
		expect(updateProvider(db, plain.id, { allowPrivate: false })!.allow_private).toBe(0);
	});
});
