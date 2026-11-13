<script lang="ts">
	import { toast } from 'svelte-sonner';
	import CheckIcon from '@lucide/svelte/icons/check';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import Loader2Icon from '@lucide/svelte/icons/loader-2';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { API_SCOPES, SCOPE_INFO, type ApiScope } from './api/scopes.js';
	import { defaultAccess, toolNamesToAccess } from '$lib/mcp-access.js';
	import McpToolPicker from './McpToolPicker.svelte';
	import { cn } from '$lib/utils.js';
	import { fadeWhenScrollable } from '$lib/fade-when-scrollable.js';
	import type { ApiKey, McpGatewayServer, McpKeyAccess, ToolInfo } from '$lib/types.js';

	let {
		open = $bindable(false),
		key,
		preset = 'llm:invoke',
		servers,
		onSaved
	}: {
		open: boolean;
		/** The key to edit; null creates one. */
		key: ApiKey | null;
		/** The scope a new key starts with. */
		preset?: ApiScope;
		/** Enabled MCP servers, for the gateway access. */
		servers: McpGatewayServer[];
		/** After a save (and, for a new key, once its secret was shown). */
		onSaved: () => void;
	} = $props();

	let label = $state('');
	let scopes = $state<Record<ApiScope, boolean>>({
		'llm:invoke': false,
		'mcp:use': false,
		'agents:run': false
	});
	/** The access the dialog opened with (kept for servers whose tools can't be listed now). */
	let initialAccess = $state<McpKeyAccess>([]);
	let tools = $state<ToolInfo[] | null>(null);
	/** Set when the gateway is turned on here, so the picker scrolls into view. */
	let revealPicker = $state(false);
	let selected = $state<string[]>([]);
	let busy = $state(false);
	/** Set by a submit attempt, so problems only show once the user tried. */
	let attempted = $state(false);
	let created = $state<{ rawKey: string; label: string; scopes: ApiScope[] } | null>(null);
	let copied = $state(false);
	let labelInput = $state<HTMLInputElement | null>(null);

	const editing = $derived(key !== null);
	const selectedScopes = $derived(API_SCOPES.filter((s) => scopes[s]));
	const labelMissing = $derived(label.trim() === '');
	const scopesMissing = $derived(selectedScopes.length === 0);

	/** The form as it opened, to tell whether an edit changed anything. */
	let baseline = $state('');
	let baselineTools = $state<string | null>(null);
	const formState = $derived(`${label.trim()}|${selectedScopes.join(',')}`);
	const toolsState = $derived([...selected].sort().join(','));
	const dirty = $derived(
		formState !== baseline || (baselineTools !== null && toolsState !== baselineTools)
	);

	/** "Model inference · MCP gateway (27 tools)": what the key will get, shown by the save button. */
	const grantSummary = $derived(
		selectedScopes
			.map((scope) =>
				scope === 'mcp:use' && tools
					? `${SCOPE_INFO[scope].title} (${selected.length} ${selected.length === 1 ? 'tool' : 'tools'})`
					: SCOPE_INFO[scope].title
			)
			.join(' · ')
	);

	// Reset the form each time the dialog opens.
	let wasOpen = false;
	$effect(() => {
		if (open && !wasOpen) init();
		wasOpen = open;
	});

	function init() {
		label = key?.label ?? '';
		for (const scope of API_SCOPES) {
			scopes[scope] = key ? key.scopes.includes(scope) : scope === preset;
		}
		initialAccess = key?.mcpAccess ?? defaultAccess(servers);
		tools = null;
		revealPicker = false;
		selected = [];
		attempted = false;
		created = null;
		copied = false;
		baseline = `${label.trim()}|${API_SCOPES.filter((s) => scopes[s]).join(',')}`;
		baselineTools = null;
	}

	/** The access to save: unchanged until the tools loaded (nothing could be edited before). */
	function accessToSave(): McpKeyAccess | undefined {
		if (!scopes['mcp:use'] || !tools) return undefined;
		return toolNamesToAccess(selected, initialAccess, servers, tools);
	}

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (busy) return;
		attempted = true;
		if (labelMissing) {
			labelInput?.focus();
			return;
		}
		if (scopesMissing) return;
		busy = true;
		try {
			const body = { label: label.trim(), scopes: selectedScopes, mcpAccess: accessToSave() };
			const res = await fetch(editing ? `/api/api-keys/${key!.id}` : '/api/api-keys', {
				method: editing ? 'PATCH' : 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (!res.ok) {
				const payload = (await res.json().catch(() => null)) as { message?: string } | null;
				throw new Error(payload?.message ?? `Request failed (${res.status})`);
			}
			if (editing) {
				toast.success('API key updated');
				open = false;
				onSaved();
			} else {
				const payload = (await res.json()) as { key: { rawKey: string } };
				created = { rawKey: payload.key.rawKey, label: label.trim(), scopes: selectedScopes };
			}
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to save the API key');
		} finally {
			busy = false;
		}
	}

	function setOpen(value: boolean) {
		open = value;
		if (!value && created) onSaved();
	}

	async function copyKey() {
		try {
			await navigator.clipboard.writeText(created?.rawKey ?? '');
			copied = true;
			toast.success('Copied');
		} catch {
			toast.error('Failed to copy');
		}
	}
</script>

{#snippet code(text: string)}<code class="rounded bg-muted px-1 py-0.5 font-mono text-xs"
		>{text}</code
	>{/snippet}

<Dialog.Root {open} onOpenChange={setOpen}>
	<Dialog.Content
		class={cn(
			// Pinned near the top, so turning the MCP gateway on grows the dialog down instead of re-centring it.
			'top-[5dvh] flex max-h-[min(90dvh,52rem)] translate-y-0 flex-col gap-0 overflow-hidden p-0 sm:top-[8dvh]',
			scopes['mcp:use'] && !created ? 'sm:max-w-2xl' : 'sm:max-w-lg'
		)}
	>
		{#if created}
			<Dialog.Header class="px-6 pt-6 pr-14 pb-4">
				<Dialog.Title>Key “{created.label}” created</Dialog.Title>
				<Dialog.Description>
					Use it as {@render code('Authorization: Bearer <key>')}.
				</Dialog.Description>
			</Dialog.Header>
			<div class="flex flex-col gap-4 px-6 pb-6">
				<div
					class="flex items-start gap-2 rounded-xl bg-amber-500/10 px-3 py-2.5 text-sm text-amber-800 dark:text-amber-300"
				>
					<TriangleAlertIcon class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
					<p>Copy it now. Chatty only keeps a hash, so it can't show the key again.</p>
				</div>
				<code
					class="block rounded-xl border border-border/60 bg-muted/40 px-3 py-2.5 font-mono text-xs leading-relaxed break-all select-all"
					aria-label="New API key">{created.rawKey}</code
				>
				<div class="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
					Can do:
					{#each created.scopes as scope (scope)}
						<Badge variant="secondary" class="font-normal">{SCOPE_INFO[scope].title}</Badge>
					{/each}
				</div>
			</div>
			<div class="flex justify-end gap-2 border-t border-border/60 px-6 py-4">
				<span class="sr-only" aria-live="polite">{copied ? 'API key copied' : ''}</span>
				<Button variant="ghost" onclick={() => setOpen(false)}>Done</Button>
				<Button variant={copied ? 'outline' : 'default'} onclick={copyKey}>
					{#if copied}<CheckIcon class="size-4" />Copied{:else}<CopyIcon class="size-4" />Copy key{/if}
				</Button>
			</div>
		{:else}
			<Dialog.Header class="px-6 pt-6 pr-14 pb-4">
				<Dialog.Title>{editing ? 'Edit API key' : 'Create API key'}</Dialog.Title>
				<Dialog.Description>
					{#if key?.oauthClient}
						{key.oauthClient} signed in with this key. Changes apply to its next request; delete the key
						to sign it out.
					{:else if editing}
						Changes apply to the next request. The key itself stays the same.
					{:else}
						The key acts as you. Give it only what the app using it needs.
					{/if}
				</Dialog.Description>
			</Dialog.Header>
			<form onsubmit={submit} novalidate class="flex min-h-0 flex-1 flex-col">
				<div
					{@attach fadeWhenScrollable}
					class="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-6 pt-1 pb-6 data-more-below:[mask-image:linear-gradient(to_bottom,black_calc(100%-1.25rem),transparent)]"
				>
					<div class="flex flex-col gap-2">
						<Label for="api-key-label">Label</Label>
						<Input
							id="api-key-label"
							bind:ref={labelInput}
							bind:value={label}
							maxlength={100}
							placeholder="e.g. Claude Code on my laptop"
							aria-invalid={attempted && labelMissing}
							aria-describedby={attempted && labelMissing ? 'api-key-label-error' : undefined}
						/>
						{#if attempted && labelMissing}
							<p id="api-key-label-error" class="flex items-center gap-1 text-xs text-destructive">
								<CircleAlertIcon class="size-3.5 shrink-0" aria-hidden="true" />
								Name the key so you can tell it apart later.
							</p>
						{/if}
					</div>

					<fieldset class="flex flex-col gap-2">
						<legend class="mb-2 text-sm font-medium">What it can do</legend>
						<div
							class="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60"
						>
							{#each API_SCOPES as scope (scope)}
								{@const info = SCOPE_INFO[scope]}
								<label
									for="scope-{scope}"
									class={cn(
										'flex cursor-pointer items-center gap-3 px-3 py-3 transition-colors hover:bg-accent/40 motion-reduce:transition-none',
										scopes[scope] && 'bg-primary/5'
									)}
								>
									<span
										class={cn(
											'flex size-8 shrink-0 items-center justify-center rounded-lg',
											scopes[scope]
												? 'bg-primary/10 text-foreground ring-1 ring-primary/25'
												: 'bg-muted text-muted-foreground ring-1 ring-border/60'
										)}
									>
										<info.icon class="size-4" />
									</span>
									<span class="flex min-w-0 flex-1 flex-col gap-0.5">
										<span class="flex flex-wrap items-center gap-x-2 text-sm font-medium">
											{info.title}
											<code class="font-mono text-xs font-normal text-muted-foreground"
												>{scope}</code
											>
										</span>
										<span class="text-xs text-muted-foreground">
											{info.description}
										</span>
									</span>
									<Switch
										id="scope-{scope}"
										bind:checked={scopes[scope]}
										aria-label={info.title}
										onCheckedChange={(on) => {
											if (scope === 'mcp:use' && on) revealPicker = true;
										}}
									/>
								</label>
							{/each}
						</div>
						{#if attempted && scopesMissing}
							<p class="flex items-center gap-1 text-xs text-destructive">
								<CircleAlertIcon class="size-3.5 shrink-0" aria-hidden="true" />Turn on at least
								one.
							</p>
						{/if}
					</fieldset>

					{#if scopes['mcp:use']}
						<div class="border-t border-border/60 pt-5">
							<McpToolPicker
								{servers}
								{initialAccess}
								bind:tools
								bind:selected
								reveal={revealPicker}
								onLoaded={(picked) => {
									// Only a key that already had the gateway counts its loaded picks as unchanged.
									baselineTools = key?.scopes.includes('mcp:use')
										? [...picked].sort().join(',')
										: '';
								}}
							/>
						</div>
					{/if}
				</div>
				<div class="flex shrink-0 items-center gap-2 border-t border-border/60 px-6 py-4">
					<p
						class="mr-auto min-w-0 truncate text-xs text-muted-foreground max-sm:hidden"
						title={grantSummary}
					>
						{grantSummary ? `Grants: ${grantSummary}` : 'Nothing selected yet'}
					</p>
					<Dialog.Close>
						{#snippet child({ props })}
							<Button {...props} type="button" variant="ghost">Cancel</Button>
						{/snippet}
					</Dialog.Close>
					<Button
						type="submit"
						disabled={busy || (editing && !dirty)}
						title={editing && !dirty ? 'Nothing changed yet' : undefined}
					>
						{#if busy}<Loader2Icon class="size-4 animate-spin motion-reduce:animate-none" />{/if}
						{editing ? 'Save changes' : 'Create key'}
					</Button>
				</div>
			</form>
		{/if}
	</Dialog.Content>
</Dialog.Root>
