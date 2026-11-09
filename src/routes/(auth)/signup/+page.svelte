<script lang="ts">
	import { authClient } from '$lib/auth-client.js';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { tick } from 'svelte';
	import Loader2Icon from '@lucide/svelte/icons/loader-2';
	import CircleDashedIcon from '@lucide/svelte/icons/circle-dashed';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import AuthCard from '$lib/components/app/auth/AuthCard.svelte';
	import AuthError from '$lib/components/app/auth/AuthError.svelte';
	import PasswordInput from '$lib/components/app/auth/PasswordInput.svelte';
	import SsoButton from '$lib/components/app/auth/SsoButton.svelte';
	import { autofocus } from '$lib/components/app/auth/autofocus.js';
	import type { PageData } from './$types';

	const MIN_PASSWORD_LENGTH = 8;

	let { data }: { data: PageData } = $props();

	let name = $state('');
	let email = $state('');
	let password = $state('');
	let errorMessage = $state('');
	let loading = $state(false);
	let oidcLoading = $state(false);
	let emailInput = $state<HTMLElement | null>(null);
	let passwordInput = $state<HTMLInputElement | null>(null);
	/** Which field a server-side error refers to, for aria-invalid and focus. */
	let errorField = $state<'email' | 'password'>('email');

	const passwordOk = $derived(password.length >= MIN_PASSWORD_LENGTH);
	// Set once the browser blocks a submit because the password is too short,
	// so the hint can turn into an error instead of staying a quiet suggestion.
	let passwordRejected = $state(false);
	const passwordError = $derived(passwordRejected && !passwordOk);

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		loading = true;
		errorMessage = '';
		const { error } = await authClient.signUp.email({
			name,
			email,
			password,
			callbackURL: '/'
		});
		if (error) {
			errorMessage = error.message ?? 'Sign up failed';
			// Most sign-up errors concern the email (already taken, invalid).
			errorField = error.code?.includes('PASSWORD') ? 'password' : 'email';
			loading = false;
			await tick();
			(errorField === 'password' ? passwordInput : emailInput)?.focus();
			return;
		}
		await goto(resolve('/'), { invalidateAll: true });
	}
</script>

<svelte:head>
	<title>Create account · Chatty</title>
</svelte:head>

{#snippet signinLink()}
	Already have an account?
	<a href={resolve('/login')} class="font-medium text-foreground underline-offset-4 hover:underline"
		>Sign in</a
	>
{/snippet}

<AuthCard
	title={data.authConfig.signup || data.authConfig.oidc
		? 'Create your account'
		: 'Sign-up is closed'}
	description={data.authConfig.signup
		? 'Get started with your own Chatty workspace'
		: data.authConfig.oidc
			? 'Accounts on this instance are created through single sign-on.'
			: 'New accounts are disabled on this instance. Ask your administrator for access.'}
	footer={signinLink}
>
	{#if data.authConfig.oidc}
		<SsoButton
			primary={!data.authConfig.signup}
			divider={data.authConfig.signup}
			disabled={loading}
			bind:loading={oidcLoading}
		/>
	{/if}

	{#if data.authConfig.signup}
		<form
			onsubmit={submit}
			oninput={() => (errorMessage = '')}
			oninvalidcapture={(e) => {
				if (e.target !== passwordInput) return;
				// The hint below already explains the rule: show it instead of the native bubble.
				e.preventDefault();
				passwordRejected = true;
				passwordInput?.focus();
			}}
			class="flex flex-col gap-4"
			aria-busy={loading}
		>
			<fieldset disabled={loading || oidcLoading} class="contents">
				<div class="flex flex-col gap-2">
					<Label for="name">Name</Label>
					<Input
						id="name"
						name="name"
						type="text"
						bind:value={name}
						required
						autocomplete="name"
						{@attach autofocus}
					/>
				</div>
				<div class="flex flex-col gap-2">
					<Label for="email">Email</Label>
					<Input
						id="email"
						name="email"
						type="email"
						bind:value={email}
						required
						autocomplete="email"
						bind:ref={emailInput}
						aria-invalid={errorMessage && errorField === 'email' ? true : undefined}
						aria-describedby={errorMessage ? 'auth-error' : undefined}
					/>
				</div>
				<div class="flex flex-col gap-2">
					<Label for="password">Password</Label>
					<PasswordInput
						id="password"
						name="password"
						bind:value={password}
						bind:ref={passwordInput}
						aria-invalid={passwordError || (errorMessage && errorField === 'password')
							? true
							: undefined}
						required
						minlength={MIN_PASSWORD_LENGTH}
						autocomplete="new-password"
						aria-describedby="password-hint{errorMessage ? ' auth-error' : ''}"
					/>
					<p
						id="password-hint"
						aria-live="polite"
						class="flex items-center gap-1.5 text-xs transition-colors {passwordOk
							? 'text-success-foreground'
							: passwordError
								? 'text-destructive'
								: 'text-muted-foreground'}"
					>
						{#if passwordOk}
							<CircleCheckIcon class="size-3.5 shrink-0" aria-hidden="true" />
						{:else if passwordError}
							<CircleAlertIcon class="size-3.5 shrink-0" aria-hidden="true" />
						{:else}
							<CircleDashedIcon class="size-3.5 shrink-0" aria-hidden="true" />
						{/if}
						At least {MIN_PASSWORD_LENGTH} characters
						<span class="sr-only">{passwordOk ? '(requirement met)' : '(not met yet)'}</span>
					</p>
				</div>
				{#if errorMessage}
					<AuthError id="auth-error" message={errorMessage} />
				{/if}
				<Button type="submit" disabled={loading || oidcLoading} class="mt-1 w-full">
					{#if loading}
						<Loader2Icon class="animate-spin" aria-hidden="true" />
						Creating account…
					{:else}
						Create account
					{/if}
				</Button>
			</fieldset>
		</form>
	{/if}
</AuthCard>
