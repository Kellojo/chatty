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
	import * as Table from '$lib/components/ui/table/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
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

<div class="flex flex-col gap-4">
	<div class="flex items-center justify-between gap-4">
		<div class="flex flex-col gap-1">
			<h2 class="text-xl font-semibold">Coding environments</h2>
			<p class="text-sm text-muted-foreground">
				Remote T3 Code servers connected to your account. Chatty reads their status and provider
				usage — see <a class="underline" href={resolve('/usage')}>Usage</a>.
			</p>
		</div>
		<Button onclick={() => openForm(null)}>Connect environment</Button>
	</div>

	<Card.Root>
		<Card.Content>
			<Table.Root>
				<Table.Header>
					<Table.Row>
						<Table.Head>Name</Table.Head>
						<Table.Head>URL</Table.Head>
						<Table.Head>Status</Table.Head>
						<Table.Head>Last synced</Table.Head>
						<Table.Head>Enabled</Table.Head>
						<Table.Head class="text-right">Actions</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.environments as env (env.id)}
						<Table.Row>
							<Table.Cell class="max-w-40 font-medium" title={env.name}>
								<div class="flex flex-col">
									<span class="truncate">{env.name}</span>
									{#if env.serverVersion}
										<span class="text-xs font-normal text-muted-foreground">
											T3 Code {env.serverVersion}
										</span>
									{/if}
								</div>
							</Table.Cell>
							<Table.Cell class="max-w-56 truncate text-muted-foreground" title={env.baseUrl}>
								{env.baseUrl}
							</Table.Cell>
							<Table.Cell>
								<EnvironmentStatusBadge environment={env} />
							</Table.Cell>
							<Table.Cell class="text-muted-foreground">
								{env.lastSyncedAt ? formatTimeAgo(env.lastSyncedAt) : 'Never'}
							</Table.Cell>
							<Table.Cell>
								<Switch
									checked={enabledOverride[env.id] ?? env.enabled}
									onCheckedChange={(checked) => toggleEnabled(env, checked)}
								/>
							</Table.Cell>
							<Table.Cell class="text-right whitespace-nowrap">
								<div class="flex justify-end gap-2">
									<Button
										variant="outline"
										size="sm"
										disabled={syncBusyId === env.id || !env.enabled}
										onclick={() => sync(env)}
									>
										{#if syncBusyId === env.id}
											<Loader2Icon class="size-4 animate-spin" />
											Syncing…
										{:else}
											Sync now
										{/if}
									</Button>
									<Button variant="outline" size="sm" onclick={() => openForm(env)}>Edit</Button>
									<Button
										variant="destructive"
										size="sm"
										onclick={() => {
											deleteTarget = env;
											deleteOpen = true;
										}}
									>
										Remove
									</Button>
								</div>
							</Table.Cell>
						</Table.Row>
					{:else}
						<Table.Row>
							<Table.Cell colspan={6} class="text-center text-muted-foreground">
								No coding environments connected yet.
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</Card.Content>
	</Card.Root>
</div>

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
