import type { PrivateDataStatus } from '$lib/types.js';
import { isPrivateDataEnabled } from './feature.js';
import type { Db } from '../db/index.js';
import { roleTrusted } from './models.js';
import { hasTrustedProvider } from './policy.js';

/** What the app shell needs to show (or hide) private-data controls. */
export function privateDataStatus(db: Db): PrivateDataStatus {
	return {
		enabled: isPrivateDataEnabled(db),
		available: hasTrustedProvider(db),
		sttTrusted: roleTrusted(db, 'speech-to-text'),
		ttsTrusted: roleTrusted(db, 'text-to-speech')
	};
}

/** Names of the enabled providers trusted with private data (shown in the settings diagram). */
export function trustedProviderNames(db: Db): string[] {
	return (
		db
			.prepare(
				'SELECT name FROM providers WHERE enabled = 1 AND allow_private = 1 ORDER BY created_at'
			)
			.all() as { name: string }[]
	).map((p) => p.name);
}
