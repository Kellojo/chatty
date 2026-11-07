<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { toast } from 'svelte-sonner';
	import Loader2Icon from '@lucide/svelte/icons/loader-2';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import ServerIcon from '@lucide/svelte/icons/server';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import SettingsHeader from '$lib/components/app/settings/SettingsHeader.svelte';
	import SettingsSection from '$lib/components/app/settings/SettingsSection.svelte';
	import SettingsListItem from '$lib/components/app/settings/SettingsListItem.svelte';
	import RowMenu from '$lib/components/app/settings/RowMenu.svelte';
	import EnvironmentStatusBadge from '$lib/components/app/EnvironmentStatusBadge.svelte';
	import { formatTimeAgo } from '$lib/datetime.js';
	import LinkIcon from '@lucide/svelte/icons/link';
	import XIcon from '@lucide/svelte/icons/x';
	import { parseEnvironmentUrl, type CodingEnvironment } from '$lib/coding-environments.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let formOpen = $state(false);
	let formTarget = $state<CodingEnvironment | null>(null);
	let formName = $state('');
	let formUrl = $state('');
	let formToken = $state('');
	/** One-time code split off a pasted `…/pair#token=…` link. */
	let formPairingToken = $state<string | null>(null);
	let formBusy = $state(false);

	let deleteOpen = $state(false);
	let deleteTarget = $state<CodingEnvironment | null>(null);
	let deleteBusy = $state(false);

	let syncBusyId = $state<string | null>(null);
	let enabledOverride = $state<Record<string, boolean>>({});

	const tokenCommand =
		't3 auth session issue --scope orchestration:read --scope orchestration:operate --scope diagnostics:read --scope source-control:write --scope workspace --token-only';

	async function api(path: string, method: string, body?: unknown): Promise<Response> {
		const res = await fetch(path, {
			method,
			headers: body === undefined ? undefined : { 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body)
		});
		if (!res.ok) {
			const payload = (await res.json().catch(() => null)) as { message?: string } | null;
			throw new Error(payload?.message ?? `Request failed (${res.status})`);
		}
		return res;
	}

	function openForm(env: CodingEnvironment | null) {
		formTarget = env;
		formName = env?.name ?? '';
		formUrl = env?.baseUrl ?? '';
		formToken = '';
		formPairingToken = null;
		formOpen = true;
	}

	function reportStatus(env: CodingEnvironment) {
		if (env.status === 'online') toast.success(`Connected to "${env.name}"`);
		else if (env.status === 'error')
			toast.error(`"${env.name}": ${env.lastError ?? 'unreachable'}`);
	}

	/** Splits a pasted pairing link into the server URL and its pairing code. */
	function onUrlInput() {
		const parsed = parseEnvironmentUrl(formUrl);
		if (!parsed?.pairingToken) return;
		formUrl = parsed.baseUrl;
		formPairingToken = parsed.pairingToken;
		formToken = '';
		if (!formName.trim()) formName = new URL(parsed.baseUrl).hostname.split('.')[0] ?? '';
	}

	function credentials(): Record<string, string> {
		if (formPairingToken) return { pairingToken: formPairingToken };
		return formToken ? { token: formToken } : {};
	}

	async function readEnvironment(res: Response): Promise<CodingEnvironment> {
		return ((await res.json()) as { environment: CodingEnvironment }).environment;
	}

	async function submitForm(event: SubmitEvent) {
		event.preventDefault();
		formBusy = true;
		try {
			if (formTarget) {
				await api(`/api/coding-environments/${formTarget.id}`, 'PATCH', {
					name: formName,
					baseUrl: formUrl,
					...credentials()
				});
				if (formTarget.enabled) {
					reportStatus(
						await readEnvironment(
							await api(`/api/coding-environments/${formTarget.id}/sync`, 'POST')
						)
					);
				}
			} else {
				reportStatus(
					await readEnvironment(
						await api('/api/coding-environments', 'POST', {
							name: formName,
							baseUrl: formUrl,
							...credentials()
						})
					)
				);
			}
			formOpen = false;
			await invalidateAll();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to save environment');
		} finally {
			formBusy = false;
		}
	}

	async function toggleEnabled(env: CodingEnvironment, enabled: boolean) {
		enabledOverride[env.id] = enabled;
		try {
			await api(`/api/coding-environments/${env.id}`, 'PATCH', { enabled });
			await invalidateAll();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to update environment');
		} finally {
			delete enabledOverride[env.id];
		}
	}

	async function sync(env: CodingEnvironment) {
		syncBusyId = env.id;
		try {
			reportStatus(
				await readEnvironment(await api(`/api/coding-environments/${env.id}/sync`, 'POST'))
			);
			await invalidateAll();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Sync failed');
		} finally {
			syncBusyId = null;
		}
	}

	async function confirmDelete() {
		if (!deleteTarget) return;
		deleteBusy = true;
		try {
			await api(`/api/coding-environments/${deleteTarget.id}`, 'DELETE');
			toast.success(`Environment "${deleteTarget.name}" removed`);
			deleteOpen = false;
			await invalidateAll();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to remove environment');
		} finally {
			deleteBusy = false;
		}
	}
</script>

<svelte:head><title>Coding environments · Settings · Chatty</title></svelte:head>

<SettingsHeader title="Coding environments">
	{#snippet description()}
		Remote T3 Code servers connected to your account. Chatty runs coding tasks on them and reads
		their provider usage for
		<a class="underline underline-offset-4 hover:text-foreground" href={resolve('/usage')}>Usage</a
		>.
	{/snippet}
	{#snippet actions()}
		<Button onclick={() => openForm(null)}><PlusIcon class="size-4" />Connect environment</Button>
	{/snippet}
</SettingsHeader>

<SettingsSection flush>
	{#if data.environments.length === 0}
		<div class="flex flex-col items-center gap-3 px-6 py-10 text-center">
			<div
				class="flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground"
			>
				<ServerIcon class="size-5" />
			</div>
			<div class="flex max-w-sm flex-col gap-1">
				<p class="text-sm font-medium">No environments connected</p>
				<p class="text-sm text-muted-foreground">
					Run <code class="rounded bg-muted px-1 py-0.5 text-xs">t3 serve</code> on a machine and paste
					its pairing link to run coding tasks there.
				</p>
			</div>
			<Button size="sm" onclick={() => openForm(null)}>
				<PlusIcon class="size-4" />Connect environment
			</Button>
		</div>
	{:else}
		<ul class="divide-y divide-border/60" aria-label="Coding environments">
			{#each data.environments as env (env.id)}
				{@const enabled = enabledOverride[env.id] ?? env.enabled}
				<SettingsListItem title={env.name} muted={!enabled}>
					{#snippet leading()}<ServerIcon class="size-4" />{/snippet}
					{#snippet badges()}<EnvironmentStatusBadge environment={env} />{/snippet}
					{#snippet meta()}
						<span title={env.baseUrl}>{env.baseUrl}</span>
					{/snippet}
					<p class="text-xs text-muted-foreground">
						{#if env.serverVersion}T3 Code {env.serverVersion} ·{/if}
						{syncBusyId === env.id
							? 'Syncing…'
							: env.lastSyncedAt
								? `Synced ${formatTimeAgo(env.lastSyncedAt)}`
								: 'Never synced'}
					</p>
					{#if env.status === 'error' && env.lastError && enabled}
						<p class="line-clamp-2 text-xs text-destructive" title={env.lastError}>
							{env.lastError}
						</p>
					{/if}
					{#snippet trailing()}
						<Button
							variant="ghost"
							size="icon-sm"
							class="hidden sm:inline-flex"
							title="Sync now"
							aria-label="Sync {env.name} now"
							disabled={syncBusyId === env.id || !env.enabled}
							onclick={() => sync(env)}
						>
							{#if syncBusyId === env.id}
								<Loader2Icon class="size-4 animate-spin" />
							{:else}
								<RefreshCwIcon class="size-4" />
							{/if}
						</Button>
						<Switch
							checked={enabled}
							aria-label="Enable {env.name}"
							onCheckedChange={(checked) => toggleEnabled(env, checked)}
						/>
						<RowMenu
							label="Actions for {env.name}"
							items={[
								{
									label: 'Sync now',
									icon: RefreshCwIcon,
									disabled: syncBusyId === env.id || !env.enabled,
									onSelect: () => sync(env)
								},
								{ label: 'Edit', icon: PencilIcon, onSelect: () => openForm(env) },
								'separator',
								{
									label: 'Remove',
									icon: Trash2Icon,
									destructive: true,
									onSelect: () => {
										deleteTarget = env;
										deleteOpen = true;
									}
								}
							]}
						/>
					{/snippet}
				</SettingsListItem>
			{/each}
		</ul>
	{/if}
</SettingsSection>

<Dialog.Root bind:open={formOpen}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>{formTarget ? 'Edit environment' : 'Connect environment'}</Dialog.Title>
			<Dialog.Description>
				Point Chatty at a T3 Code server (<code>t3 serve</code>). Use HTTPS or a private network
				such as Tailscale; the token is encrypted at rest.
			</Dialog.Description>
		</Dialog.Header>
		<form onsubmit={submitForm} class="flex flex-col gap-4">
			<div class="flex flex-col gap-2">
				<Label for="env-name">Name</Label>
				<Input id="env-name" bind:value={formName} required maxlength={64} placeholder="devbox" />
			</div>
			<div class="flex flex-col gap-2">
				<Label for="env-url">Server URL or pairing link</Label>
				<Input
					id="env-url"
					type="url"
					bind:value={formUrl}
					oninput={onUrlInput}
					required
					placeholder="https://devbox.tailnet.ts.net/pair#token=…"
				/>
			</div>
			{#if formPairingToken}
				<div
					class="flex items-start gap-2 rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-xs"
				>
					<LinkIcon class="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
					<p class="flex-1 text-muted-foreground">
						<span class="font-medium text-foreground">Pairing link detected.</span>
						Chatty will exchange it for a token that can read usage, start coding tasks and show images
						the agent saves. The link works once.
					</p>
					<button
						type="button"
						class="rounded p-0.5 text-muted-foreground hover:text-foreground"
						aria-label="Use an access token instead"
						title="Use an access token instead"
						onclick={() => (formPairingToken = null)}
					>
						<XIcon class="size-3.5" />
					</button>
				</div>
			{:else}
				<div class="flex flex-col gap-2">
					<Label for="env-token">Access token</Label>
					<Input
						id="env-token"
						type="password"
						bind:value={formToken}
						required={!formTarget}
						autocomplete="off"
						placeholder={formTarget ? 'Leave empty to keep current token' : ''}
					/>
					<p class="text-xs text-muted-foreground">
						Paste a pairing link above (<code>t3 auth pairing create</code>), or issue a token on
						the server with:
						<code class="mt-1 block rounded bg-muted px-2 py-1 font-mono text-[11px] break-all"
							>{tokenCommand}</code
						>
					</p>
				</div>
			{/if}
			<Dialog.Footer>
				<Button type="submit" disabled={formBusy}>
					{#if formBusy}
						<Loader2Icon class="size-4 animate-spin" />
						Connecting…
					{:else}
						{formTarget ? 'Save changes' : 'Connect'}
					{/if}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={deleteOpen}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Remove {deleteTarget?.name}?</Dialog.Title>
			<Dialog.Description>
				This removes the connection, its stored token and the usage Chatty synced from it. The T3
				Code server itself is not affected.
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (deleteOpen = false)}>Cancel</Button>
			<Button variant="destructive" disabled={deleteBusy} onclick={confirmDelete}>
				{deleteBusy ? 'Removing…' : 'Remove'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
