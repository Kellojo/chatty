// VAPID identifies this server to browser push services. The key pair comes
// from the environment, or is generated once and stored in `push_vapid_keys`
// (private key encrypted) so subscriptions stay valid across restarts: browsers
// bind a subscription to the public key it was made with.
import { generateVAPIDKeys } from 'web-push';
import { config } from '../config.js';
import { decryptSecret, encryptSecret } from '../crypto.js';
import type { Db } from '../db/index.js';
import { createLogger } from '../logger.js';

const log = createLogger('push');

/** Used when neither VAPID_SUBJECT nor an https ORIGIN is configured. */
export const DEFAULT_VAPID_SUBJECT = 'https://github.com/Kellojo/ai-chat';

export interface VapidDetails {
	subject: string;
	publicKey: string;
	privateKey: string;
}

type SubjectConfig = Pick<typeof config, 'VAPID_SUBJECT' | 'ORIGIN'>;

export function vapidSubject(c: SubjectConfig = config): string {
	if (c.VAPID_SUBJECT) return c.VAPID_SUBJECT;
	if (c.ORIGIN?.startsWith('https://')) return new URL(c.ORIGIN).origin;
	return DEFAULT_VAPID_SUBJECT;
}

const cache = new WeakMap<Db, VapidDetails>();

export function getVapidDetails(db: Db): VapidDetails {
	const cached = cache.get(db);
	if (cached) return cached;
	const details = loadVapidDetails(db);
	cache.set(db, details);
	return details;
}

function loadVapidDetails(db: Db): VapidDetails {
	const subject = vapidSubject();
	if (config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY) {
		return { subject, publicKey: config.VAPID_PUBLIC_KEY, privateKey: config.VAPID_PRIVATE_KEY };
	}
	const row = db
		.prepare('SELECT public_key, private_key_encrypted FROM push_vapid_keys WHERE id = 1')
		.get() as { public_key: string; private_key_encrypted: string } | undefined;
	if (row) {
		try {
			return {
				subject,
				publicKey: row.public_key,
				privateKey: decryptSecret(row.private_key_encrypted)
			};
		} catch {
			// The app secret changed, so the stored key is unreadable. Start over with
			// a new pair; devices pick up the new key when they next open Chatty.
			log.warn(
				'Stored VAPID key could not be decrypted (APP_SECRET changed?); generating a new pair'
			);
			db.prepare('DELETE FROM push_vapid_keys WHERE id = 1').run();
		}
	}
	const keys = generateVAPIDKeys();
	// Another request may have raced us here; keep whichever pair landed first.
	db.prepare(
		`INSERT INTO push_vapid_keys (id, public_key, private_key_encrypted, created_at)
		 VALUES (1, ?, ?, ?) ON CONFLICT(id) DO NOTHING`
	).run(keys.publicKey, encryptSecret(keys.privateKey), Date.now());
	return loadVapidDetails(db);
}
