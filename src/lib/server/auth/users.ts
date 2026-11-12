import { config } from '../config.js';
import { auth } from './index.js';
import type { UserRole } from '$lib/types.js';

/** Whether accounts can sign in with an email and password on this instance. */
export function passwordLoginEnabled(): boolean {
	return config.ENABLE_PASSWORD_LOGIN && !config.OIDC_ONLY;
}

export class AdminUserError extends Error {}

async function hashPassword(password: string): Promise<string> {
	const ctx = await auth.$context;
	const { minPasswordLength, maxPasswordLength } = ctx.password.config;
	if (password.length < minPasswordLength) {
		throw new AdminUserError(`Password must be at least ${minPasswordLength} characters`);
	}
	if (password.length > maxPasswordLength) {
		throw new AdminUserError(`Password must be at most ${maxPasswordLength} characters`);
	}
	return ctx.password.hash(password);
}

/**
 * Creates an email + password account on an admin's behalf. Goes through
 * better-auth's internal adapter rather than `signUpEmail`, which would both
 * respect `disableSignUp` and sign the *admin's* browser in as the new user.
 */
export async function createPasswordUser(input: {
	name: string;
	email: string;
	password: string;
	role: UserRole;
}): Promise<string> {
	const ctx = await auth.$context;
	const email = input.email.trim().toLowerCase();
	if (await ctx.internalAdapter.findUserByEmail(email)) {
		throw new AdminUserError('A user with that email already exists');
	}
	const hash = await hashPassword(input.password);
	const user = await ctx.internalAdapter.createUser(
		{
			name: input.name.trim(),
			email,
			emailVerified: false,
			role: input.role
		},
		{ method: 'admin' }
	);
	await ctx.internalAdapter.linkAccount({
		userId: user.id,
		providerId: 'credential',
		accountId: user.id,
		password: hash
	});
	return user.id;
}

/**
 * Sets a user's password, adding a password sign-in if they only had OIDC.
 * Signs them out everywhere so the old password's sessions don't linger.
 */
export async function setUserPassword(userId: string, password: string): Promise<void> {
	const ctx = await auth.$context;
	const hash = await hashPassword(password);
	const accounts = await ctx.internalAdapter.findAccounts(userId);
	if (accounts.some((account) => account.providerId === 'credential')) {
		await ctx.internalAdapter.updatePassword(userId, hash);
	} else {
		await ctx.internalAdapter.linkAccount({
			userId,
			providerId: 'credential',
			accountId: userId,
			password: hash
		});
	}
	await ctx.internalAdapter.deleteUserSessions(userId);
}
