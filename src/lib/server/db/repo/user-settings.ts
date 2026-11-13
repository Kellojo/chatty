import type { Db } from '../index.js';
import {
	DEFAULT_USER_SETTINGS,
	NOTIFICATION_TRIGGER_KEYS,
	THEMES,
	TIME_FORMATS,
	type NotificationTriggers,
	type Theme,
	type TimeFormat,
	type UserSettings
} from '$lib/user-settings.js';

interface UserSettingRow {
	key: string;
	value: string;
}

export function getUserSetting<T>(db: Db, userId: string, key: string): T | undefined {
	const row = db
		.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?')
		.get(userId, key) as Pick<UserSettingRow, 'value'> | undefined;
	if (!row) return undefined;
	return JSON.parse(row.value) as T;
}

export function setUserSetting(db: Db, userId: string, key: string, value: unknown): void {
	db.prepare(
		`INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)
		 ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`
	).run(userId, key, JSON.stringify(value));
}

export function deleteUserSetting(db: Db, userId: string, key: string): void {
	db.prepare('DELETE FROM user_settings WHERE user_id = ? AND key = ?').run(userId, key);
}

// Each setting's stored value (undefined when unset), validated, with its default.

function parseTheme(value: unknown): Theme {
	return THEMES.includes(value as Theme) ? (value as Theme) : DEFAULT_USER_SETTINGS.theme;
}

function parseSuggestionList(value: unknown, key: 'suggestions' | 'codingSuggestions'): string[] {
	if (!Array.isArray(value)) return DEFAULT_USER_SETTINGS[key];
	return value.filter((s): s is string => typeof s === 'string' && s.trim().length > 0);
}

function parseGlobalInstructions(value: unknown): string {
	if (typeof value !== 'string') return DEFAULT_USER_SETTINGS.globalInstructions;
	return value.trim();
}

function parseTimeFormat(value: unknown): TimeFormat {
	return TIME_FORMATS.includes(value as TimeFormat)
		? (value as TimeFormat)
		: DEFAULT_USER_SETTINGS.timeFormat;
}

function parseSidebarOpen(value: unknown): boolean {
	return typeof value === 'boolean' ? value : DEFAULT_USER_SETTINGS.sidebarOpen;
}

function parseFavoriteModels(value: unknown): string[] {
	if (!Array.isArray(value)) return DEFAULT_USER_SETTINGS.favoriteModels;
	return [...new Set(value.filter((v): v is string => typeof v === 'string' && v.includes('/')))];
}

/** Stored trigger flags merged over `base`, so new trigger keys default sensibly. */
function readTriggers(value: unknown, base: NotificationTriggers): NotificationTriggers {
	const triggers = { ...base };
	if (value && typeof value === 'object') {
		for (const key of NOTIFICATION_TRIGGER_KEYS) {
			const v = (value as Record<string, unknown>)[key];
			if (typeof v === 'boolean') triggers[key] = v;
		}
	}
	return triggers;
}

export function getTheme(db: Db, userId: string): Theme {
	return parseTheme(getUserSetting<unknown>(db, userId, 'theme'));
}

export function getSuggestions(db: Db, userId: string): string[] {
	return parseSuggestionList(getUserSetting<unknown>(db, userId, 'suggestions'), 'suggestions');
}

export function getCodingSuggestions(db: Db, userId: string): string[] {
	return parseSuggestionList(
		getUserSetting<unknown>(db, userId, 'codingSuggestions'),
		'codingSuggestions'
	);
}

export function getGlobalInstructions(db: Db, userId: string): string {
	return parseGlobalInstructions(getUserSetting<unknown>(db, userId, 'globalInstructions'));
}

export function getTimeFormat(db: Db, userId: string): TimeFormat {
	return parseTimeFormat(getUserSetting<unknown>(db, userId, 'timeFormat'));
}

export function getSidebarOpen(db: Db, userId: string): boolean {
	return parseSidebarOpen(getUserSetting<unknown>(db, userId, 'sidebarOpen'));
}

export function getFavoriteModels(db: Db, userId: string): string[] {
	return parseFavoriteModels(getUserSetting<unknown>(db, userId, 'favoriteModels'));
}

/** What an open tab alerts about. */
export function getNotificationTriggers(db: Db, userId: string): NotificationTriggers {
	return readTriggers(
		getUserSetting<unknown>(db, userId, 'notificationTriggers'),
		DEFAULT_USER_SETTINGS.notificationTriggers
	);
}

/** What is pushed. Keys never set follow the tab's choice, which predates per-channel triggers. */
export function getPushTriggers(db: Db, userId: string): NotificationTriggers {
	return readTriggers(
		getUserSetting<unknown>(db, userId, 'pushTriggers'),
		getNotificationTriggers(db, userId)
	);
}

/** Changes some tab triggers. Push triggers that still follow them are pinned first. */
export function updateNotificationTriggers(
	db: Db,
	userId: string,
	patch: Partial<NotificationTriggers>
): void {
	db.transaction(() => {
		if (getUserSetting(db, userId, 'pushTriggers') === undefined) {
			setUserSetting(db, userId, 'pushTriggers', getPushTriggers(db, userId));
		}
		setUserSetting(db, userId, 'notificationTriggers', {
			...getNotificationTriggers(db, userId),
			...patch
		});
	})();
}

/** Changes some push triggers. */
export function updatePushTriggers(
	db: Db,
	userId: string,
	patch: Partial<NotificationTriggers>
): void {
	setUserSetting(db, userId, 'pushTriggers', { ...getPushTriggers(db, userId), ...patch });
}

/** All of the user's settings, read in one query. */
export function getUserSettings(db: Db, userId: string): UserSettings {
	const rows = db
		.prepare('SELECT key, value FROM user_settings WHERE user_id = ?')
		.all(userId) as UserSettingRow[];
	const stored = new Map(rows.map((row) => [row.key, JSON.parse(row.value) as unknown]));
	const notificationTriggers = readTriggers(
		stored.get('notificationTriggers'),
		DEFAULT_USER_SETTINGS.notificationTriggers
	);
	return {
		theme: parseTheme(stored.get('theme')),
		suggestions: parseSuggestionList(stored.get('suggestions'), 'suggestions'),
		codingSuggestions: parseSuggestionList(stored.get('codingSuggestions'), 'codingSuggestions'),
		globalInstructions: parseGlobalInstructions(stored.get('globalInstructions')),
		timeFormat: parseTimeFormat(stored.get('timeFormat')),
		sidebarOpen: parseSidebarOpen(stored.get('sidebarOpen')),
		favoriteModels: parseFavoriteModels(stored.get('favoriteModels')),
		notificationTriggers,
		pushTriggers: readTriggers(stored.get('pushTriggers'), notificationTriggers)
	};
}
