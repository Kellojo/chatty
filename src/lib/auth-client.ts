import { createAuthClient } from 'better-auth/svelte';

// better-auth >=1.7 routes generic OAuth providers through the core
// `signIn.social` endpoint, so no client plugin is needed.
export const authClient = createAuthClient();
