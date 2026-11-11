import { createAuthClient } from 'better-auth/svelte';
import { resolve } from '$app/paths';
import { toast } from 'svelte-sonner';
import { disablePush } from '$lib/notifications/push.js';

// better-auth >=1.7 routes generic OAuth providers through the core
// `signIn.social` endpoint, so no client plugin is needed.
export const authClient = createAuthClient();

/**
 * Ends the session and leaves for the login page; on failure, says so and stays put.
 * Turns off push on this device first.
 * A full page load, so nothing from the signed-in session stays in memory.
 * Resolves `false` if signing out failed.
 */
export async function signOutToLogin(): Promise<boolean> {
	// Stop pushes first, while still signed in to unregister: a signed-out
	// phone must not keep showing this account's chats on its lock screen.
	await disablePush().catch(() => undefined);
	try {
		const { error } = await authClient.signOut();
		if (error) throw new Error(error.message);
	} catch {
		toast.error("Couldn't sign out. Try again.");
		return false;
	}
	window.location.assign(resolve('/login'));
	return true;
}
