<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
	import ArrowDownIcon from '@lucide/svelte/icons/arrow-down';
	import XIcon from '@lucide/svelte/icons/x';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import RouteIcon from '@lucide/svelte/icons/route';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import SettingsHeader from '$lib/components/app/settings/SettingsHeader.svelte';
	import SettingsSection from '$lib/components/app/settings/SettingsSection.svelte';
	import SettingsListItem from '$lib/components/app/settings/SettingsListItem.svelte';
	import RowMenu from '$lib/components/app/settings/RowMenu.svelte';
	import ModelSelect from '$lib/components/app/ModelSelect.svelte';
	import ProviderIcon from '$lib/components/app/ProviderIcon.svelte';
	import { resolveBrand, resolveModelBrand } from '$lib/provider-brand.js';
	import type { ModelsByProvider } from '$lib/types.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	type Mapping = PageData['mappings'][number];
	type TargetRow = { providerId: string; modelId: string };

	let dialogOpen = $state(false);
	let editingId = $state<string | null>(null);
	let formName = $state('');
	let formTargets = $state<TargetRow[]>([]);
	let formBusy = $state(false);

	let deleteId = $state<string | null>(null);
	let deleteBusy = $state(false);

	const providersById = $derived(new Map(data.providers.map((p) => [p.id, p])));
	const modelsByRef = $derived(
		new Map(data.models.map((m) => [`${m.providerId}/${m.modelId}`, m]))
	);

	/** A target as shown in the table: the model's display name and maker, like the pickers. */
	function describeTarget(target: TargetRow) {
		const model = modelsByRef.get(`${target.providerId}/${target.modelId}`);
		const provider = providersById.get(target.providerId);
		return {
			name: model?.displayName ?? target.modelId,
			provider: provider?.name ?? target.providerId,
			brand: resolveModelBrand(model ?? target, provider)
		};
	}

	/** Only a name that names a vendor gets its logo; targets are listed in the row itself. */
	function mappingBrand(mapping: Mapping) {
		return resolveBrand(mapping.name);
	}

	const modelGroups = $derived.by<ModelsByProvider[]>(() => {
		const byProvider: Record<string, PageData['models']> = {};
		for (const model of data.models) {
			(byProvider[model.providerId] ??= []).push(model);
		}
		return data.providers
			.filter((p) => p.id in byProvider)
			.map((p) => ({ provider: p, models: byProvider[p.id]! }));
	});

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

	function openAdd() {
		editingId = null;
		formName = '';
		formTargets = [{ providerId: '', modelId: '' }];
		dialogOpen = true;
	}

	function openEdit(mapping: Mapping) {
		editingId = mapping.id;
		formName = mapping.name;
		formTargets = mapping.targets.map((t) => ({ ...t }));
		dialogOpen = true;
	}

	function addTarget() {
		formTargets = [...formTargets, { providerId: '', modelId: '' }];
	}

	function removeTarget(index: number) {
		formTargets = formTargets.filter((_, i) => i !== index);
	}

	function moveTarget(index: number, delta: number) {
		const next = index + delta;
		if (next < 0 || next >= formTargets.length) return;
		const copy = [...formTargets];
		const [row] = copy.splice(index, 1);
		copy.splice(next, 0, row!);
		formTargets = copy;
	}

	function setTargetModelRef(index: number, ref: string) {
		const slash = ref.indexOf('/');
		const providerId = slash === -1 ? '' : ref.slice(0, slash);
		const modelId = slash === -1 ? '' : ref.slice(slash + 1);
		formTargets = formTargets.map((t, i) => (i === index ? { providerId, modelId } : t));
	}

	async function submitForm(event: SubmitEvent) {
		event.preventDefault();
		const name = formName.trim();
		const targets = formTargets.filter((t) => t.providerId !== '' && t.modelId !== '');
		if (targets.length === 0) {
			toast.error('Add at least one target with a provider and model');
			return;
		}
		formBusy = true;
		try {
			if (editingId) {
				await api(`/api/model-mappings/${editingId}`, 'PATCH', { name, targets });
				toast.success(`Mapping "${name}" updated`);
			} else {
				await api('/api/model-mappings', 'POST', { name, targets });
				toast.success(`Mapping "${name}" created`);
			}
			dialogOpen = false;
			await invalidateAll();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to save mapping');
		} finally {
			formBusy = false;
		}
	}

	async function toggleEnabled(mapping: Mapping, enabled: boolean) {
		try {
			await api(`/api/model-mappings/${mapping.id}`, 'PATCH', { enabled });
			toast.success(`Mapping "${mapping.name}" ${enabled ? 'enabled' : 'disabled'}`);
			await invalidateAll();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to update mapping');
		}
	}

	async function confirmDelete() {
		if (!deleteId) return;
		deleteBusy = true;
		try {
			await api(`/api/model-mappings/${deleteId}`, 'DELETE');
			toast.success('Mapping deleted');
			deleteId = null;
			await invalidateAll();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to delete mapping');
		} finally {
			deleteBusy = false;
		}
	}
</script>

<svelte:head><title>Mappings · Settings · Chatty</title></svelte:head>

<SettingsHeader title="Mappings">
	{#snippet description()}
		Named aliases that try their target models in order until one answers. Pick them like any model
		in chats and Defaults, or pass the name in the
		<code class="rounded bg-muted px-1 py-0.5 text-xs">model</code> field of the API.
	{/snippet}
	{#snippet actions()}
		<!-- The empty state below has its own button; one is enough. -->
		{#if data.mappings.length > 0}
			<Button onclick={openAdd} disabled={data.models.length === 0}>
				<PlusIcon class="size-4" />Add mapping
			</Button>
		{/if}
	{/snippet}
</SettingsHeader>

<SettingsSection flush>
	{#if data.mappings.length === 0}
		<div class="flex flex-col items-center gap-3 px-6 py-10 text-center">
			<div
				class="flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground"
			>
				<RouteIcon class="size-5" />
			</div>
			<div class="flex max-w-sm flex-col gap-1">
				<p class="text-sm font-medium">No mappings yet</p>
				<p class="text-sm text-muted-foreground">
					Add one to expose a stable name like <code class="text-xs">fast</code> with fallback models
					behind it.
				</p>
			</div>
			<Button size="sm" onclick={openAdd} disabled={data.models.length === 0}>
				<PlusIcon class="size-4" />Add mapping
			</Button>
		</div>
	{:else}
		<ul class="divide-y divide-border/60" aria-label="Model mappings">
			{#each data.mappings as mapping (mapping.id)}
				{@const brand = mappingBrand(mapping)}
				<SettingsListItem
					title={mapping.name}
					muted={!mapping.enabled}
					onclick={() => openEdit(mapping)}
				>
					{#snippet leading()}
						{#if brand}
							<ProviderIcon {brand} class="size-4" />
						{:else}
							<RouteIcon class="size-4" />
						{/if}
					{/snippet}
					<ol
						class="mt-1 flex flex-wrap items-center gap-1.5 text-xs"
						aria-label="Targets in order"
					>
						{#each mapping.targets as target, i (i)}
							{@const t = describeTarget(target)}
							<li class="flex max-w-full min-w-0 items-center gap-1.5">
								{#if i > 0}<span class="text-muted-foreground" aria-hidden="true">→</span>{/if}
								<span
									class="inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 whitespace-nowrap"
									title="{t.provider} / {target.modelId}"
								>
									{#if t.brand}<ProviderIcon brand={t.brand} class="size-3 shrink-0" />{/if}
									<span class="truncate">{t.name}</span>
									<!-- Phones: the brand icon names the provider; the model id gets the room. -->
									<span class="shrink-0 text-muted-foreground max-sm:hidden">{t.provider}</span>
								</span>
							</li>
						{/each}
					</ol>
					{#snippet trailing()}
						<Switch
							checked={mapping.enabled}
							aria-label="Enable {mapping.name}"
							onCheckedChange={(checked) => toggleEnabled(mapping, checked)}
						/>
						<RowMenu
							label="Actions for {mapping.name}"
							items={[
								{ label: 'Edit', icon: PencilIcon, onSelect: () => openEdit(mapping) },
								'separator',
								{
									label: 'Delete',
									icon: Trash2Icon,
									destructive: true,
									onSelect: () => (deleteId = mapping.id)
								}
							]}
						/>
					{/snippet}
				</SettingsListItem>
			{/each}
		</ul>
	{/if}
</SettingsSection>

<Dialog.Root bind:open={dialogOpen}>
	<Dialog.Content class="sm:max-w-xl">
		<Dialog.Header>
			<Dialog.Title
				>{editingId
					? `Edit ${data.mappings.find((m) => m.id === editingId)?.name ?? 'mapping'}`
					: 'Add mapping'}</Dialog.Title
			>
			<Dialog.Description>
				A named alias with ordered fallback targets, tried in order until one answers.
			</Dialog.Description>
		</Dialog.Header>
		<form onsubmit={submitForm} class="flex flex-col gap-4">
			<div class="flex flex-col gap-2">
				<Label for="mapping-name">Name</Label>
				<Input id="mapping-name" bind:value={formName} required placeholder="fast" />
			</div>
			<div class="flex flex-col gap-2">
				<Label>Targets (tried in order)</Label>
				{#each formTargets as target, i (i)}
					<div class="flex items-center gap-2">
						<ModelSelect
							groups={modelGroups}
							value={target.providerId && target.modelId
								? `${target.providerId}/${target.modelId}`
								: ''}
							onselect={(v) => setTargetModelRef(i, v)}
							placeholder="Select model"
							class="w-full min-w-0"
						/>
						<Button
							variant="outline"
							size="icon-sm"
							onclick={() => moveTarget(i, -1)}
							disabled={i === 0}
							title="Move up"
							aria-label="Move target {i + 1} up"
						>
							<ArrowUpIcon class="size-4" />
						</Button>
						<Button
							variant="outline"
							size="icon-sm"
							onclick={() => moveTarget(i, 1)}
							disabled={i === formTargets.length - 1}
							title="Move down"
							aria-label="Move target {i + 1} down"
						>
							<ArrowDownIcon class="size-4" />
						</Button>
						<Button
							variant="outline"
							size="icon-sm"
							onclick={() => removeTarget(i)}
							disabled={formTargets.length <= 1}
							title="Remove target"
							aria-label="Remove target {i + 1}"
						>
							<XIcon class="size-4" />
						</Button>
					</div>
				{/each}
				<div>
					<Button
						variant="outline"
						size="sm"
						onclick={addTarget}
						disabled={formTargets.length >= 10}
					>
						<PlusIcon class="size-4" />
						Add target
					</Button>
				</div>
			</div>
			<Dialog.Footer>
				<Dialog.Close>
					{#snippet child({ props })}
						<Button {...props} type="button" variant="outline">Cancel</Button>
					{/snippet}
				</Dialog.Close>
				<Button type="submit" disabled={formBusy}>
					{formBusy ? 'Saving…' : editingId ? 'Save changes' : 'Add mapping'}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root open={deleteId !== null} onOpenChange={(open) => !open && (deleteId = null)}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title
				>Delete {data.mappings.find((m) => m.id === deleteId)?.name ?? 'mapping'}?</Dialog.Title
			>
			<Dialog.Description>
				Chats, Defaults and API clients that use this alias stop working until you pick another
				model.
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (deleteId = null)}>Cancel</Button>
			<Button variant="destructive" disabled={deleteBusy} onclick={confirmDelete}>
				{deleteBusy ? 'Deleting…' : 'Delete'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
