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
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
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
	import HistoryIcon from '@lucide/svelte/icons/history';
	import XIcon from '@lucide/svelte/icons/x';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import { SvelteSet } from 'svelte/reactivity';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import {
		MAX_HISTORY_IMPORT,
		parseEnvironmentUrl,
		type CodingEnvironment,
		type CodingHistoryThread
	} from '$lib/coding-environments.js';
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

	let historyOpen = $state(false);
	let historyTarget = $state<CodingEnvironment | null>(null);
	let historyThreads = $state<CodingHistoryThread[] | null>(null);
	let historyError = $state<string | null>(null);
	let historyFilter = $state('');
	let historyBusy = $state(false);
	const historySelected = new SvelteSet<string>();

	const visibleHistory = $derived.by(() => {
		const q = historyFilter.trim().toLowerCase();
		const threads = historyThreads ?? [];
		if (!q) return threads;
		return threads.filter(
			(t) => t.title.toLowerCase().includes(q) || t.projectTitle.toLowerCase().includes(q)
		);
	});
	const allVisibleSelected = $derived(
		visibleHistory.length > 0 && visibleHistory.every((t) => historySelected.has(t.threadId))
	);

	/** Status of the automatic import of past sessions right after connecting. */
	type InitialImport =
		| { state: 'importing' }
		| { state: 'done'; imported: number; skipped: number }
		| { state: 'error'; message: string };
	let initialImportOpen = $state(false);
	let initialImportEnv = $state<CodingEnvironment | null>(null);
	let initialImport = $state<InitialImport>({ state: 'importing' });

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
				const created = await readEnvironment(
					await api('/api/coding-environments', 'POST', {
						name: formName,
						baseUrl: formUrl,
						...credentials()
					})
				);
				reportStatus(created);
				if (created.enabled && created.status === 'online') void importAllPast(created);
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

	async function openHistory(env: CodingEnvironment) {
		historyTarget = env;
		historyThreads = null;
		historyError = null;
		historyFilter = '';
		historySelected.clear();
		historyOpen = true;
		try {
			const res = await api(`/api/coding-environments/${env.id}/history`, 'GET');
			const { threads } = (await res.json()) as { threads: CodingHistoryThread[] };
			if (historyTarget?.id === env.id) historyThreads = threads;
		} catch (e) {
			if (historyTarget?.id === env.id) {
				historyError = e instanceof Error ? e.message : 'Failed to load sessions';
			}
		}
	}

	function toggleHistory(threadId: string, checked: boolean) {
		if (!checked) historySelected.delete(threadId);
		else if (historySelected.size < MAX_HISTORY_IMPORT) historySelected.add(threadId);
	}

	function toggleAllHistory() {
		if (allVisibleSelected) {
			for (const t of visibleHistory) historySelected.delete(t.threadId);
			return;
		}
		for (const t of visibleHistory) {
			if (historySelected.size >= MAX_HISTORY_IMPORT) break;
			historySelected.add(t.threadId);
		}
	}

	async function importHistory() {
		if (!historyTarget || historySelected.size === 0) return;
		historyBusy = true;
		try {
			const res = await api(`/api/coding-environments/${historyTarget.id}/history`, 'POST', {
				threadIds: [...historySelected]
			});
			const { imported } = (await res.json()) as { imported: number };
			toast.success(imported === 1 ? 'Imported 1 session' : `Imported ${imported} sessions`, {
				description: 'Their history loads in the background.'
			});
			historyOpen = false;
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Import failed');
		} finally {
			historyBusy = false;
		}
	}

	/** Brings in every live past session of a freshly connected environment. */
	async function importAllPast(env: CodingEnvironment) {
		initialImportEnv = env;
		initialImport = { state: 'importing' };
		initialImportOpen = true;
		try {
			const res = await api(`/api/coding-environments/${env.id}/history`, 'POST', { all: true });
			const result = (await res.json()) as { imported: number; skipped: number };
			if (initialImportEnv?.id !== env.id) return;
			// Hidden while importing: report it the light way instead.
			if (!initialImportOpen && result.imported > 0) {
				toast.success(`Imported ${sessions(result.imported)} from "${env.name}"`);
			}
			// Nothing to report: don't leave a dialog up just to say so.
			if (result.imported === 0 && result.skipped === 0) initialImportOpen = false;
			initialImport = { state: 'done', ...result };
		} catch (e) {
			if (initialImportEnv?.id !== env.id) return;
			const message = e instanceof Error ? e.message : 'Failed to import past sessions';
			if (!initialImportOpen) toast.error(`Couldn't import past sessions: ${message}`);
			initialImport = { state: 'error', message };
		}
	}

	function sessions(n: number): string {
		return n === 1 ? '1 session' : `${n} sessions`;
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
		<!-- The empty state below has its own button; one is enough. -->
		{#if data.environments.length > 0}
			<Button onclick={() => openForm(null)}><PlusIcon class="size-4" />Connect environment</Button>
		{/if}
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
				<SettingsListItem title={env.name} muted={!enabled} onclick={() => openForm(env)}>
					{#snippet leading()}<ServerIcon class="size-4" />{/snippet}
					{#snippet badges()}<EnvironmentStatusBadge environment={env} />{/snippet}
					{#snippet meta()}
						<!-- External T3 Code server, not an app route. -->
						<!-- eslint-disable svelte/no-navigation-without-resolve -->
						<a
							href={env.baseUrl}
							target="_blank"
							rel="noopener noreferrer"
							class="relative z-10 rounded-sm hover:text-foreground hover:underline hover:underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
							title="Open {env.name} in T3 Code">{env.baseUrl}</a
						>
						<!-- eslint-enable svelte/no-navigation-without-resolve -->
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
						{#if syncBusyId === env.id}
							<Loader2Icon class="size-4 animate-spin text-muted-foreground" aria-hidden="true" />
						{/if}
						<Switch
							checked={enabled}
							aria-label="Enable {env.name}"
							onCheckedChange={(checked) => toggleEnabled(env, checked)}
						/>
						<RowMenu
							label="Actions for {env.name}"
							items={[
								{ label: 'Edit', icon: PencilIcon, onSelect: () => openForm(env) },
								{
									label: 'Open in T3 Code',
									icon: ExternalLinkIcon,
									onSelect: () => window.open(env.baseUrl, '_blank', 'noopener,noreferrer')
								},
								'separator',
								{
									label: 'Sync now',
									icon: RefreshCwIcon,
									disabled: syncBusyId === env.id || !enabled,
									onSelect: () => sync(env)
								},
								{
									label: 'Import past sessions',
									icon: HistoryIcon,
									disabled: !enabled,
									onSelect: () => openHistory(env)
								},
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
			<Dialog.Title>{formTarget ? `Edit ${formTarget.name}` : 'Connect environment'}</Dialog.Title>
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
				<Dialog.Close>
					{#snippet child({ props })}
						<Button {...props} type="button" variant="outline">Cancel</Button>
					{/snippet}
				</Dialog.Close>
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

<Dialog.Root bind:open={historyOpen}>
	<Dialog.Content class="sm:max-w-xl">
		<Dialog.Header>
			<Dialog.Title>Import past sessions</Dialog.Title>
			<Dialog.Description>
				Threads on {historyTarget?.name} that aren't in Chatty yet. Imported sessions show up as coding
				tasks with their full history and stay in sync with T3 Code.
			</Dialog.Description>
		</Dialog.Header>
		{#if historyError}
			<p class="text-sm text-destructive">{historyError}</p>
		{:else if historyThreads === null}
			<div class="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
				<Loader2Icon class="size-4 animate-spin" />Loading sessions…
			</div>
		{:else if historyThreads.length === 0}
			<p class="py-10 text-center text-sm text-muted-foreground">
				Every session on this environment is already in Chatty.
			</p>
		{:else}
			<div class="flex items-center gap-2">
				<Input
					bind:value={historyFilter}
					placeholder="Filter by title or project"
					aria-label="Filter sessions"
					class="h-8"
				/>
				<Button variant="outline" size="sm" onclick={toggleAllHistory}>
					{allVisibleSelected ? 'Clear' : 'Select all'}
				</Button>
			</div>
			<ul
				class="-mx-1 max-h-80 divide-y divide-border/60 overflow-y-auto px-1"
				aria-label="Past sessions"
			>
				{#each visibleHistory as thread (thread.threadId)}
					{@const checked = historySelected.has(thread.threadId)}
					<li>
						<label class="flex cursor-pointer items-start gap-3 py-2">
							<input
								type="checkbox"
								class="mt-0.5 size-4 shrink-0 accent-primary"
								{checked}
								disabled={!checked && historySelected.size >= MAX_HISTORY_IMPORT}
								onchange={(e) => toggleHistory(thread.threadId, e.currentTarget.checked)}
							/>
							<span class="flex min-w-0 flex-1 flex-col gap-0.5">
								<span class="flex items-center gap-2">
									<span class="truncate text-sm font-medium" title={thread.title}
										>{thread.title}</span
									>
									{#if thread.archived}<Badge variant="secondary">Archived</Badge>{/if}
									{#if thread.dismissed}<Badge variant="outline">Deleted in Chatty</Badge>{/if}
								</span>
								<span class="truncate text-xs text-muted-foreground">
									{thread.projectTitle} · {thread.model} · {formatTimeAgo(thread.updatedAt)}
								</span>
							</span>
						</label>
					</li>
				{:else}
					<li class="py-6 text-center text-sm text-muted-foreground">No matching sessions.</li>
				{/each}
			</ul>
		{/if}
		<Dialog.Footer class="items-center">
			{#if historyThreads?.length}
				<p class="mr-auto text-xs text-muted-foreground">
					{historySelected.size} selected{historySelected.size >= MAX_HISTORY_IMPORT
						? ` (max ${MAX_HISTORY_IMPORT} per import)`
						: ''}
				</p>
			{/if}
			<Button variant="outline" onclick={() => (historyOpen = false)}>Cancel</Button>
			<Button disabled={historyBusy || historySelected.size === 0} onclick={importHistory}>
				{#if historyBusy}
					<Loader2Icon class="size-4 animate-spin" />Importing…
				{:else}
					Import{historySelected.size > 0 ? ` ${historySelected.size}` : ''}
				{/if}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={initialImportOpen}>
	<Dialog.Content class="sm:max-w-sm">
		<Dialog.Header>
			<Dialog.Title>Syncing past sessions</Dialog.Title>
			<Dialog.Description>From {initialImportEnv?.name}</Dialog.Description>
		</Dialog.Header>
		<div class="flex items-start gap-3 rounded-md border border-border/60 bg-muted/40 px-3 py-3">
			{#if initialImport.state === 'importing'}
				<Loader2Icon class="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" />
				<div class="flex flex-col gap-0.5 text-sm">
					<p class="font-medium">Importing past sessions…</p>
					<p class="text-xs text-muted-foreground">You can close this, the import keeps going.</p>
				</div>
			{:else if initialImport.state === 'done'}
				<CircleCheckIcon class="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
				<div class="flex flex-col gap-0.5 text-sm">
					<p class="font-medium">Imported {sessions(initialImport.imported)}</p>
					<p class="text-xs text-muted-foreground">
						Their history loads in the background and stays in sync with T3 Code.
						{#if initialImport.skipped > 0}
							{sessions(initialImport.skipped)} left out to stay under the limit of open tasks.
						{/if}
						Archived ones can be added with <span class="font-medium">Import past sessions</span>.
					</p>
				</div>
			{:else}
				<CircleAlertIcon class="mt-0.5 size-4 shrink-0 text-destructive" />
				<div class="flex flex-col gap-0.5 text-sm">
					<p class="font-medium">Couldn't import past sessions</p>
					<p class="text-xs break-words text-muted-foreground">{initialImport.message}</p>
				</div>
			{/if}
		</div>
		<Dialog.Footer>
			{#if initialImport.state === 'error' && initialImportEnv}
				{@const env = initialImportEnv}
				<Button variant="outline" onclick={() => importAllPast(env)}>Try again</Button>
			{/if}
			<Button
				variant={initialImport.state === 'importing' ? 'outline' : 'default'}
				onclick={() => (initialImportOpen = false)}
			>
				{initialImport.state === 'importing' ? 'Hide' : 'Done'}
			</Button>
		</Dialog.Footer>
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
