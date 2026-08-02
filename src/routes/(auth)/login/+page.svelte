<script lang="ts">
	import { authClient } from '$lib/auth-client.js';
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let email = $state('');
	let password = $state('');
	let oidcLoading = $state(false);
	let errorMessage = $state('');
	let loading = $state(false);

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		loading = true;
		errorMessage = '';
		const { error } = await authClient.signIn.email({
			email,
			password,
			callbackURL: '/'
		});
		if (error) {
			errorMessage = error.message ?? 'Sign in failed';
			loading = false;
		}
	}

	async function signInWithOidc() {
		try {
			oidcLoading = true;
			await authClient.signIn.oauth2({ providerId: 'oidc', callbackURL: '/' });
		} catch (e) {
			errorMessage = e instanceof Error ? e.message : 'SSO sign in failed';
		} finally {
			oidcLoading = false;
		}
	}
</script>

<div class="flex w-full flex-col gap-6 rounded-4xl border bg-card p-8 text-card-foreground">
	<h1 class="text-center text-xl font-semibold tracking-tight">Sign in</h1>

	{#if data.authConfig.passwordLogin}
		<form onsubmit={submit} class="flex flex-col gap-4">
			<div class="flex flex-col gap-2">
				<Label for="email">Email</Label>
				<Input id="email" type="email" bind:value={email} required autocomplete="email" />
			</div>
			<div class="flex flex-col gap-2">
				<Label for="password">Password</Label>
				<Input
					id="password"
					type="password"
					bind:value={password}
					required
					autocomplete="current-password"
				/>
			</div>
			{#if errorMessage}
				<p class="text-sm text-destructive">{errorMessage}</p>
			{/if}
			<Button type="submit" disabled={loading} class="w-full">
				{loading ? 'Signing in…' : 'Sign in'}
			</Button>
		</form>
	{/if}

	{#if data.authConfig.oidc}
		<Button
			variant="outline"
			onclick={signInWithOidc}
			disabled={oidcLoading || loading}
			class="w-full"
		>
			{#if oidcLoading}
				<svg class="size-4 animate-spin" viewBox="0 0 24 24" fill="none">
					<path
						d="M12 2a10 10 0 0 1 10 10"
						stroke="currentColor"
						stroke-width="3"
						stroke-linecap="round"
					/>
				</svg>
				Redirecting…
			{:else}
				Sign in with SSO
			{/if}
		</Button>
	{/if}

	{#if data.authConfig.signup}
		<p class="text-center text-sm text-muted-foreground">
			No account? <a
				href={resolve('/signup')}
				class="text-foreground underline-offset-4 hover:underline">Sign up</a
			>
		</p>
	{/if}
</div>
