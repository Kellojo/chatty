import type { PrivateDataStatus } from '$lib/types.js';
import { isPrivateDataEnabled } from './feature.js';
import type { Db } from '../db/index.js';
import { roleTrusted } from './egress.js';
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
