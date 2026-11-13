<script lang="ts">
	import { authClient } from '$lib/auth-client.js';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { safeRedirectPath } from '$lib/redirect-to.js';
	import { tick } from 'svelte';
	import Loader2Icon from '@lucide/svelte/icons/loader-2';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import AuthCard from '$lib/components/app/auth/AuthCard.svelte';
	import AuthError from '$lib/components/app/auth/AuthError.svelte';
	import PasswordInput from '$lib/components/app/auth/PasswordInput.svelte';
	import SsoButton from '$lib/components/app/auth/SsoButton.svelte';
	import { autofocus } from '$lib/components/app/auth/autofocus.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	/** Where to go once signed in: back to e.g. an OAuth approval, else home. */
	const redirectTo = $derived(safeRedirectPath(page.url.searchParams.get('redirectTo')));
	/** Keeps ?redirectTo= when switching between sign-in and sign-up. */
	const withRedirect = (path: string) =>
		redirectTo === '/' ? path : `${path}?redirectTo=${encodeURIComponent(redirectTo)}`;

	let email = $state('');
	let password = $state('');
	let oidcLoading = $state(false);
	let errorMessage = $state('');
	let loading = $state(false);
	let passwordInput = $state<HTMLInputElement | null>(null);

	const busy = $derived(loading || oidcLoading);
	const noMethods = $derived(!data.authConfig.passwordLogin && !data.authConfig.oidc);

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		loading = true;
		errorMessage = '';
		const { error } = await authClient.signIn.email({
			email,
			password,
			callbackURL: redirectTo
		});
		if (error) {
			errorMessage = error.message ?? 'Sign in failed';
			loading = false;
			// Make a retry one keystroke away.
			await tick();
			passwordInput?.select();
			return;
		}
		// A same-site path from ?redirectTo= (safeRedirectPath), e.g. an OAuth approval.
		// eslint-disable-next-line svelte/no-navigation-without-resolve
		await goto(redirectTo, { invalidateAll: true });
	}
</script>

<svelte:head>
	<title>Sign in · Chatty</title>
</svelte:head>

{#snippet signupLink()}
	Don't have an account?
	<!-- eslint-disable svelte/no-navigation-without-resolve -- resolve()d inside withRedirect -->
	<a
		href={withRedirect(resolve('/signup'))}
		class="font-medium text-foreground underline-offset-4 hover:underline">Create one</a
	>
	<!-- eslint-enable svelte/no-navigation-without-resolve -->
{/snippet}

<AuthCard
	title="Welcome back"
	description={noMethods
		? 'No sign-in method is enabled. Ask your administrator to enable password or SSO login.'
		: 'Sign in to your account'}
	footer={data.authConfig.signup && !noMethods ? signupLink : undefined}
>
	{#if data.authConfig.oidc}
		<SsoButton
			callbackURL={redirectTo}
			primary={!data.authConfig.passwordLogin}
			divider={data.authConfig.passwordLogin}
			disabled={loading}
			bind:loading={oidcLoading}
		/>
	{/if}

	{#if data.authConfig.passwordLogin}
		<form
			onsubmit={submit}
			oninput={() => (errorMessage = '')}
			class="flex flex-col gap-4"
			aria-busy={loading}
		>
			<fieldset disabled={busy} class="contents">
				<div class="flex flex-col gap-2">
					<Label for="email">Email</Label>
					<Input
						id="email"
						name="email"
						type="email"
						bind:value={email}
						required
						autocomplete="email"
						{@attach autofocus}
						aria-invalid={errorMessage ? true : undefined}
						aria-describedby={errorMessage ? 'auth-error' : undefined}
					/>
				</div>
				<div class="flex flex-col gap-2">
					<Label for="password">Password</Label>
					<PasswordInput
						id="password"
						name="password"
						bind:value={password}
						required
						autocomplete="current-password"
						bind:ref={passwordInput}
						aria-invalid={errorMessage ? true : undefined}
						aria-describedby={errorMessage ? 'auth-error' : undefined}
					/>
				</div>
				{#if errorMessage}
					<AuthError id="auth-error" message={errorMessage} />
				{/if}
				<Button type="submit" disabled={busy} class="mt-1 w-full">
					{#if loading}
						<Loader2Icon class="animate-spin" aria-hidden="true" />
						Signing in…
					{:else}
						Sign in
					{/if}
				</Button>
			</fieldset>
		</form>
	{/if}
</AuthCard>
