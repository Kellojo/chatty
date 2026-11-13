import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.resetModules();
process.env.DATABASE_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret';

const { openDatabase } = await import('../index.js');
const repo = await import('./user-settings.js');

function seedUser(db: ReturnType<typeof openDatabase>, id: string) {
	db.prepare(
		'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, role) VALUES (?, ?, ?, 0, 0, 0, \'user\')'
	).run(id, 'A', `${id}@example.com`);
}

describe('user-settings repo', () => {
	let db: ReturnType<typeof openDatabase>;

	beforeEach(() => {
		db = openDatabase(':memory:');
		seedUser(db, 'u1');
	});

	it('returns defaults when nothing is stored', () => {
		expect(repo.getUserSettings(db, 'u1')).toEqual({
			theme: 'system',
			suggestions: repo.getSuggestions(db, 'u1'),
			codingSuggestions: repo.getCodingSuggestions(db, 'u1'),
			globalInstructions: '',
			timeFormat: 'auto',
			sidebarOpen: true,
			favoriteModels: [],
			notificationTriggers: {
				replies: true,
				needsYou: true,
				codingFinished: true,
				failures: true,
				agentRuns: false
			},
			pushTriggers: {
				replies: true,
				needsYou: true,
				codingFinished: true,
				failures: true,
				agentRuns: false
			}
		});
		expect(repo.getTheme(db, 'u1')).toBe('system');
		expect(repo.getTimeFormat(db, 'u1')).toBe('auto');
		expect(repo.getSidebarOpen(db, 'u1')).toBe(true);
		expect(repo.getSuggestions(db, 'u1').length).toBeGreaterThan(0);
	});

	it('reads every stored setting the same as the single-key getters', () => {
		repo.setUserSetting(db, 'u1', 'theme', 'dark');
		repo.setUserSetting(db, 'u1', 'suggestions', ['a', ' ', 3]);
		repo.setUserSetting(db, 'u1', 'codingSuggestions', 'bogus');
		repo.setUserSetting(db, 'u1', 'globalInstructions', '  be brief  ');
		repo.setUserSetting(db, 'u1', 'timeFormat', 'nope');
		repo.setUserSetting(db, 'u1', 'sidebarOpen', false);
		repo.setUserSetting(db, 'u1', 'favoriteModels', ['p/m', 'p/m', 'bad', 1]);
		repo.setUserSetting(db, 'u1', 'notificationTriggers', { replies: false, agentRuns: true });
		repo.setUserSetting(db, 'u1', 'pushTriggers', { needsYou: false });
		seedUser(db, 'u2');
		repo.setUserSetting(db, 'u2', 'theme', 'light');

		const settings = repo.getUserSettings(db, 'u1');
		expect(settings).toEqual({
			theme: repo.getTheme(db, 'u1'),
			suggestions: repo.getSuggestions(db, 'u1'),
			codingSuggestions: repo.getCodingSuggestions(db, 'u1'),
			globalInstructions: repo.getGlobalInstructions(db, 'u1'),
			timeFormat: repo.getTimeFormat(db, 'u1'),
			sidebarOpen: repo.getSidebarOpen(db, 'u1'),
			favoriteModels: repo.getFavoriteModels(db, 'u1'),
			notificationTriggers: repo.getNotificationTriggers(db, 'u1'),
			pushTriggers: repo.getPushTriggers(db, 'u1')
		});
		expect(settings).toMatchObject({
			theme: 'dark',
			suggestions: ['a'],
			globalInstructions: 'be brief',
			timeFormat: 'auto',
			sidebarOpen: false,
			favoriteModels: ['p/m'],
			pushTriggers: { replies: false, needsYou: false, agentRuns: true }
		});
	});

	it('merges stored notification triggers over the defaults', () => {
		repo.setUserSetting(db, 'u1', 'notificationTriggers', {
			replies: false,
			bogus: 1,
			agentRuns: 'x'
		});
		expect(repo.getNotificationTriggers(db, 'u1')).toEqual({
			replies: false,
			needsYou: true,
			codingFinished: true,
			failures: true,
			agentRuns: false
		});
	});

	it('push triggers follow the tab triggers until set themselves', () => {
		repo.setUserSetting(db, 'u1', 'notificationTriggers', { replies: false, agentRuns: true });
		expect(repo.getPushTriggers(db, 'u1')).toMatchObject({ replies: false, agentRuns: true });
		repo.setUserSetting(db, 'u1', 'pushTriggers', { replies: true });
		expect(repo.getPushTriggers(db, 'u1')).toMatchObject({ replies: true, agentRuns: true });
		expect(repo.getNotificationTriggers(db, 'u1').replies).toBe(false);
	});

	it('keeps push triggers put when a tab trigger changes', () => {
		repo.updateNotificationTriggers(db, 'u1', { replies: false });
		expect(repo.getNotificationTriggers(db, 'u1').replies).toBe(false);
		expect(repo.getPushTriggers(db, 'u1').replies).toBe(true);
		repo.updatePushTriggers(db, 'u1', { agentRuns: true });
		repo.updateNotificationTriggers(db, 'u1', { agentRuns: false, replies: true });
		expect(repo.getPushTriggers(db, 'u1')).toMatchObject({ replies: true, agentRuns: true });
	});

	it('round-trips sidebarOpen per user', () => {
		repo.setUserSetting(db, 'u1', 'sidebarOpen', false);
		expect(repo.getSidebarOpen(db, 'u1')).toBe(false);
		seedUser(db, 'u2');
		expect(repo.getSidebarOpen(db, 'u2')).toBe(true);
	});

	it('falls back to default sidebarOpen for invalid stored data', () => {
		db.prepare('INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)').run(
			'u1',
			'sidebarOpen',
			JSON.stringify('open')
		);
		expect(repo.getSidebarOpen(db, 'u1')).toBe(true);
	});

	it('round-trips favoriteModels and drops invalid or duplicate entries', () => {
		repo.setUserSetting(db, 'u1', 'favoriteModels', ['p1/m1', 'p1/m1', 42, 'nope', 'p2/a/b']);
		expect(repo.getFavoriteModels(db, 'u1')).toEqual(['p1/m1', 'p2/a/b']);
		seedUser(db, 'u2');
		expect(repo.getFavoriteModels(db, 'u2')).toEqual([]);
		repo.setUserSetting(db, 'u1', 'favoriteModels', 'p1/m1');
		expect(repo.getFavoriteModels(db, 'u1')).toEqual([]);
	});

	it('round-trips values per user', () => {
		repo.setUserSetting(db, 'u1', 'theme', 'dark');
		repo.setUserSetting(db, 'u1', 'suggestions', ['one', 'two']);
		expect(repo.getTheme(db, 'u1')).toBe('dark');
		expect(repo.getSuggestions(db, 'u1')).toEqual(['one', 'two']);
		seedUser(db, 'u2');
		expect(repo.getTheme(db, 'u2')).toBe('system');
	});

	it('round-trips global instructions per user', () => {
		repo.setUserSetting(db, 'u1', 'globalInstructions', 'no emojis');
		expect(repo.getGlobalInstructions(db, 'u1')).toBe('no emojis');
		seedUser(db, 'u2');
		expect(repo.getGlobalInstructions(db, 'u2')).toBe('');
	});

	it('round-trips time format per user', () => {
		repo.setUserSetting(db, 'u1', 'timeFormat', '24h');
		expect(repo.getTimeFormat(db, 'u1')).toBe('24h');
		seedUser(db, 'u2');
		expect(repo.getTimeFormat(db, 'u2')).toBe('auto');
	});

	it('clears stored value via deleteUserSetting', () => {
		repo.setUserSetting(db, 'u1', 'globalInstructions', 'answer concisely');
		expect(repo.getGlobalInstructions(db, 'u1')).toBe('answer concisely');
		repo.deleteUserSetting(db, 'u1', 'globalInstructions');
		expect(repo.getGlobalInstructions(db, 'u1')).toBe('');
	});

	it('overwrites existing values', () => {
		repo.setUserSetting(db, 'u1', 'theme', 'dark');
		repo.setUserSetting(db, 'u1', 'theme', 'light');
		expect(repo.getTheme(db, 'u1')).toBe('light');
	});

	it('falls back to defaults for invalid stored data', () => {
		db.prepare('INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)').run(
			'u1',
			'theme',
			JSON.stringify('neon')
		);
		db.prepare('INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)').run(
			'u1',
			'suggestions',
			JSON.stringify('not-an-array')
		);
		db.prepare('INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)').run(
			'u1',
			'globalInstructions',
			JSON.stringify(42)
		);
		db.prepare('INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)').run(
			'u1',
			'timeFormat',
			JSON.stringify('13h')
		);
		expect(repo.getTheme(db, 'u1')).toBe('system');
		expect(repo.getSuggestions(db, 'u1').length).toBeGreaterThan(0);
		expect(repo.getGlobalInstructions(db, 'u1')).toBe('');
		expect(repo.getTimeFormat(db, 'u1')).toBe('auto');
	});

	it('cascades on user delete', () => {
		repo.setUserSetting(db, 'u1', 'theme', 'dark');
		db.prepare('DELETE FROM "user" WHERE id = ?').run('u1');
		expect(repo.getTheme(db, 'u1')).toBe('system');
	});
});
