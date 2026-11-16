/**
 * Whether users can mark chats, memory and agents private: an admin switch in
 * Settings → General, off by default. It only shows or hides the private
 * controls; the checks always run, so turning it off never exposes data that
 * is already private.
 */
import type { Db } from '../db/index.js';
import { getSetting, setSetting } from '../db/repo/settings.js';

const KEY = 'privateData.enabled';

export function isPrivateDataEnabled(db: Db): boolean {
	return getSetting<unknown>(db, KEY) === true;
}

export function setPrivateDataEnabled(db: Db, enabled: boolean): void {
	setSetting(db, KEY, enabled);
}
