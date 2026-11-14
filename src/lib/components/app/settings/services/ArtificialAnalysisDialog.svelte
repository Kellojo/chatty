<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { toast } from 'svelte-sonner';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { formatAge } from '$lib/formats.js';
	import {
		aaRequest,
		clockTime,
		refreshAaScores,
		createClock,
		type AaState
	} from '../artificial-analysis.svelte.js';

	let {
		open = $bindable(false),
		aa,
		matched,
		total
	}: {
		open?: boolean;
		aa: AaState;
		/** Local models that got a score, out of `total`. */
		matched: number;
		total: number;
	} = $props();

	let replacing = $state(false);
	let keyInput = $state('');
	let saving = $state(false);
	let refreshing = $state(false);
	const busy = $derived(refreshing);
	const showForm = $derived(!aa.key.source || replacing);
	/** Ticks while the dialog is open, so the cooldown label and Refresh button update. */
	const clock = createClock(() => open);
	const now = $derived(clock.now);
	const rateLimited = $derived(aa.status.retryAfter !== null && aa.status.retryAfter > now);
	/** Why the last key was rejected, shown under the field until it's edited. */
	let keyError = $state<string | null>(null);
	/** Mirrors the server's manual cooldown, so the button says why it's off instead of failing. */
	const MANUAL_COOLDOWN_MS = 10 * 60 * 1000;
	const nextRefreshAt = $derived(
		Math.max(
			aa.status.fetchedAt ? aa.status.fetchedAt + MANUAL_COOLDOWN_MS : 0,
			aa.status.retryAfter ?? 0
		)
	);
	const canRefresh = $derived(!busy && nextRefreshAt <= now);
	const fullTime = new Intl.DateTimeFormat([], { dateStyle: 'medium', timeStyle: 'short' });
	const waitMinutes = $derived(Math.max(0, Math.ceil((nextRefreshAt - now) / 60_000)));
	const errorText = $derived(aa.status.lastError?.replace(/\.$/, '') ?? '');

	$effect(() => {
		if (!open) {
			replacing = false;
			keyInput = '';
			keyError = null;
		}
	});

	async function saveKey(event: SubmitEvent) {
		event.preventDefault();
		saving = true;
		try {
			keyError = null;
			await aaRequest('PUT', '/api/benchmarks/key', { apiKey: keyInput.trim() });
			toast.success('Connected to Artificial Analysis');
			replacing = false;
			keyInput = '';
			await invalidateAll();
		} catch (e) {
			keyError = e instanceof Error ? e.message : 'Could not save the key';
		} finally {
			saving = false;
		}
	}

	async function disconnect() {
		if (!confirm('Disconnect Artificial Analysis? Intelligence scores disappear from Models.'))
			return;
		try {
			await aaRequest('DELETE', '/api/benchmarks/key');
			toast.success('Artificial Analysis disconnected');
			await invalidateAll();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not remove the key');
		}
	}

	async function refresh() {
		refreshing = true;
		await refreshAaScores();
		refreshing = false;
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Artificial Analysis</Dialog.Title>
			<Dialog.Description>
				Intelligence Index scores for your models, shown and sortable in
				<a class="underline underline-offset-4" href={resolve('/settings/models')}>Models</a>.
			</Dialog.Description>
		</Dialog.Header>

		<div class="flex flex-col gap-5">
			{#if aa.key.source && !replacing}
				<!-- Connected: what's there and how fresh it is. -->
				<dl
					class="grid grid-cols-3 gap-3 rounded-xl border border-border/60 bg-muted/60 p-3 text-sm"
				>
					<div class="flex flex-col gap-0.5">
						<dt
							class="text-xs text-muted-foreground"
							title="Models without a matching Artificial Analysis entry have no score"
						>
							Models scored
						</dt>
						<dd class="font-medium tabular-nums">
							{matched}<span class="font-normal text-muted-foreground">&nbsp;of {total}</span>
						</dd>
					</div>
					<div class="flex flex-col gap-0.5">
						<dt class="text-xs text-muted-foreground">Updated</dt>
						<dd
							class="font-medium"
							title={aa.status.fetchedAt ? fullTime.format(aa.status.fetchedAt) : undefined}
							aria-live="polite"
						>
							{#if busy}Refreshing…{:else if aa.status.fetchedAt}{formatAge(
									now - aa.status.fetchedAt
								)} ago{:else}Never{/if}
						</dd>
					</div>
					<div class="flex flex-col gap-0.5">
						<dt class="text-xs text-muted-foreground">Index version</dt>
						<dd class="font-medium">
							{aa.status.indexVersion ? `v${aa.status.indexVersion}` : '—'}
						</dd>
					</div>
				</dl>

				{#if aa.status.lastError}
					<div
						role="alert"
						class="flex gap-2.5 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm"
					>
						<CircleAlertIcon class="mt-0.5 size-4 shrink-0 text-destructive" />
						<div class="flex flex-col gap-0.5">
							<span class="font-medium text-destructive">Last refresh failed</span>
							<span class="text-muted-foreground"
								>{errorText}.{#if rateLimited}
									Try again after {clockTime(aa.status.retryAfter ?? 0)}.{:else}
									Try Refresh again in a moment.{/if}
								Your current scores are kept.</span
							>
						</div>
					</div>
				{/if}

				<div class="flex items-center justify-between gap-4 text-sm">
					<div class="flex min-w-0 flex-col gap-1">
						<span class="flex flex-wrap items-center gap-x-2 gap-y-1">
							<span class="font-medium">API key</span>
							<span class="font-mono text-muted-foreground">••••{aa.key.hint}</span>
							{#if aa.key.source === 'env'}
								<Badge variant="outline" class="font-normal text-muted-foreground"
									>Managed by environment</Badge
								>
							{:else}
								<span class="text-muted-foreground">· stored encrypted</span>
							{/if}
						</span>
						{#if aa.key.source === 'env'}
							<span class="text-sm text-muted-foreground">
								Set via the <code class="font-mono">ARTIFICIAL_ANALYSIS_API_KEY</code> environment variable.
								Change it there and restart the server.
							</span>
						{/if}
					</div>
					{#if aa.key.source === 'app'}
						<Button variant="outline" size="sm" onclick={() => (replacing = true)}>Replace</Button>
					{/if}
				</div>

				<p
					id="aa-refresh-note"
					class="border-t border-border/60 pt-3 text-xs text-muted-foreground"
				>
					Refreshes when you sync models or click Refresh.{#if rateLimited}<span class="block"
							>Artificial Analysis rate-limited this key, so refresh is paused.</span
						>{/if}
				</p>
			{/if}

			{#if showForm}
				<form id="aa-key-form" onsubmit={saveKey} class="flex flex-col gap-2">
					<Label for="aa-key">API key</Label>
					<Input
						id="aa-key"
						type="password"
						bind:value={keyInput}
						placeholder="Paste your Artificial Analysis key"
						autocomplete="off"
						required
						aria-invalid={keyError ? 'true' : undefined}
						aria-describedby={keyError ? 'aa-key-error' : undefined}
						oninput={() => (keyError = null)}
					/>
					{#if keyError}
						<p
							id="aa-key-error"
							role="alert"
							class="flex items-center gap-1.5 text-sm text-destructive"
						>
							<CircleAlertIcon class="size-3.5 shrink-0" />{keyError}
						</p>
					{/if}
					<p class="text-xs text-muted-foreground">
						<a
							class="inline-flex items-center gap-0.5 font-medium text-foreground underline underline-offset-4"
							href="https://artificialanalysis.ai/api-key-management-redirect"
							target="_blank"
							rel="noreferrer">Get a free key<ExternalLinkIcon class="size-3" /></a
						>
						· 100 requests a day; a refresh uses 2–3. The key is checked before it's saved, and stored
						encrypted.
					</p>
				</form>
			{/if}
		</div>

		<Dialog.Footer class="gap-2 sm:justify-between">
			{#if showForm}
				<div class="flex gap-2 max-sm:flex-col-reverse sm:ml-auto">
					{#if replacing}
						<Button variant="outline" onclick={() => (replacing = false)}>Cancel</Button>
					{/if}
					<Button type="submit" form="aa-key-form" disabled={saving || !keyInput.trim()}>
						{saving ? 'Checking key…' : replacing ? 'Save key' : 'Connect'}
					</Button>
				</div>
			{:else}
				{#if aa.key.source === 'app'}
					<Button variant="ghost" class="text-destructive sm:mr-auto" onclick={disconnect}
						>Disconnect</Button
					>
				{/if}
				<div class="flex gap-2 max-sm:flex-col-reverse sm:ml-auto">
					<!-- Refresh is secondary: it's often in cooldown, and its label carries the wait. -->
					<Button
						variant="outline"
						disabled={!canRefresh}
						aria-describedby="aa-refresh-note"
						onclick={refresh}
					>
						<RefreshCwIcon
							class="size-4 {busy ? 'animate-spin' : ''}"
						/>{#if busy}Refreshing…{:else if waitMinutes > 0}Refresh in {waitMinutes} min{:else}Refresh{/if}
					</Button>
					<Button onclick={() => (open = false)}>Done</Button>
				</div>
			{/if}
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
