import type { BetterAuthOptions } from 'better-auth';
import { genericOAuth } from 'better-auth/plugins';
import { config } from '../config.js';
import { getAppSecret } from '../crypto.js';
import { getDb, type Db } from '../db/index.js';

const oidc =
	config.OIDC_ISSUER && config.OIDC_CLIENT_ID && config.OIDC_CLIENT_SECRET
		? {
				providerId: 'oidc',
				discoveryUrl: `${config.OIDC_ISSUER.replace(/\/$/, '')}/.well-known/openid-configuration`,
				clientId: config.OIDC_CLIENT_ID,
				clientSecret: config.OIDC_CLIENT_SECRET,
				scopes: config.OIDC_SCOPES.split(' ')
			}
		: null;

/**
 * Makes `userId` an admin iff it is the earliest-inserted user and no admin
 * exists yet. A single statement in a transaction: SQLite serializes writers,
 * so only one of several concurrent first signups can win.
 */
export function promoteFirstUser(db: Db, userId: string): boolean {
	return db.transaction(
		() =>
			db
				.prepare(
					`UPDATE "user" SET role = 'admin'
					 WHERE id = ?
					   AND rowid = (SELECT MIN(rowid) FROM "user")
					   AND NOT EXISTS (SELECT 1 FROM "user" WHERE role = 'admin')`
				)
				.run(userId).changes > 0
	)();
}

export function authOptions(): BetterAuthOptions {
	return {
		appName: 'Chatty',
		...(config.ORIGIN ? { baseURL: config.ORIGIN } : {}),
		secret: getAppSecret(),
		database: getDb(),
		emailAndPassword: {
			enabled: config.ENABLE_PASSWORD_LOGIN && !config.OIDC_ONLY,
			disableSignUp: !config.ENABLE_SIGNUP || config.OIDC_ONLY
		},
		user: {
			additionalFields: {
				role: { type: 'string', defaultValue: 'user', input: false }
			}
		},
		databaseHooks: {
			user: {
				create: {
					// Promote after the insert, in one conditional UPDATE, so two
					// simultaneous first signups can't both see an empty table.
					after: async (user) => {
						if (config.AUTO_PROMOTE_FIRST_USER) promoteFirstUser(getDb(), user.id);
					}
				}
			}
		},
		plugins: [...(oidc ? [genericOAuth({ config: [oidc] })] : [])]
	};
}
