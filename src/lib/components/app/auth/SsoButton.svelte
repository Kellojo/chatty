<script lang="ts">
	import Loader2Icon from '@lucide/svelte/icons/loader-2';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import { authClient } from '$lib/auth-client.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import AuthError from './AuthError.svelte';

	let {
		primary = false,
		divider = false,
		disabled = false,
		loading = $bindable(false),
		callbackURL = '/'
	}: {
		/** Filled button when SSO is the only option, outline otherwise. */
		primary?: boolean;
		/** Render an "or" divider below, separating SSO from a password form. */
		divider?: boolean;
		disabled?: boolean;
		loading?: boolean;
		/** Where to land after signing in. */
		callbackURL?: string;
	} = $props();

	// Shown right under this button rather than in the page's form, so an SSO
	// failure never marks the email/password fields as invalid.
	let error = $state('');

	async function signIn() {
		error = '';
		loading = true;
		try {
			// better-auth creates the account on first SSO login, so this covers sign-up too.
			const result = await authClient.signIn.social({ provider: 'oidc', callbackURL });
			if (result.error) fail(result.error.message ?? 'SSO sign in failed');
			// On success the browser is navigating to the provider: keep the spinner.
		} catch (e) {
			fail(e instanceof Error ? e.message : 'SSO sign in failed');
		}
	}

	function fail(message: string) {
		loading = false;
		error = message;
	}
</script>

<Button
	variant={primary ? 'default' : 'outline'}
	onclick={signIn}
	disabled={disabled || loading}
	class="w-full"
>
	{#if loading}
		<Loader2Icon class="animate-spin" aria-hidden="true" />
		Redirecting…
	{:else}
		<KeyRoundIcon aria-hidden="true" />
		Continue with SSO
	{/if}
</Button>

{#if error}
	<AuthError message={error} />
{/if}

{#if divider}
	<div class="flex items-center gap-3 text-xs text-muted-foreground" aria-hidden="true">
		<span class="h-px flex-1 bg-border"></span>
		or
		<span class="h-px flex-1 bg-border"></span>
	</div>
{/if}
