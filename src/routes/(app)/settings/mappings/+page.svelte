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
	import * as Table from '$lib/components/ui/table/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import ModelSelect from '$lib/components/app/ModelSelect.svelte';
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

<div class="flex flex-col gap-4">
	<div class="flex items-center justify-between">
		<h2 class="text-xl font-semibold">Model Mappings</h2>
		<Button onclick={openAdd} disabled={data.models.length === 0}>Add mapping</Button>
	</div>
	<p class="text-sm text-muted-foreground">
		Mappings are named aliases served by the AI proxy: clients pass the mapping name in the
		<code>model</code> field, and its targets are tried in order until one answers.
	</p>

	<Card.Root>
		<Card.Content>
			<Table.Root>
				<Table.Header>
					<Table.Row>
						<Table.Head>Name</Table.Head>
						<Table.Head>Targets</Table.Head>
						<Table.Head>Enabled</Table.Head>
						<Table.Head class="text-right">Actions</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.mappings as mapping (mapping.id)}
						<Table.Row>
							<Table.Cell class="font-medium">{mapping.name}</Table.Cell>
							<Table.Cell class="text-muted-foreground">
								<div class="flex flex-wrap items-center gap-x-1">
									{#each mapping.targets as target, i (i)}
										{#if i > 0}<span>→</span>{/if}
										<span class="whitespace-nowrap">
											{i + 1}. {providersById.get(target.providerId)?.name ?? target.providerId} /
											{target.modelId}
										</span>
									{/each}
								</div>
							</Table.Cell>
							<Table.Cell>
								<Switch
									checked={mapping.enabled}
									onCheckedChange={(checked) => toggleEnabled(mapping, checked)}
								/>
							</Table.Cell>
							<Table.Cell class="text-right whitespace-nowrap">
								<div class="flex justify-end gap-2">
									<Button variant="outline" size="sm" onclick={() => openEdit(mapping)}>
										Edit
									</Button>
									<Button variant="destructive" size="sm" onclick={() => (deleteId = mapping.id)}>
										Delete
									</Button>
								</div>
							</Table.Cell>
						</Table.Row>
					{:else}
						<Table.Row>
							<Table.Cell colspan={4} class="text-center text-muted-foreground">
								No mappings yet. Add one to expose a named alias with fallback targets.
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</Card.Content>
	</Card.Root>
</div>

<Dialog.Root bind:open={dialogOpen}>
	<Dialog.Content class="sm:max-w-xl">
		<Dialog.Header>
			<Dialog.Title>{editingId ? 'Edit mapping' : 'Add mapping'}</Dialog.Title>
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
						>
							<ArrowUpIcon class="size-4" />
						</Button>
						<Button
							variant="outline"
							size="icon-sm"
							onclick={() => moveTarget(i, 1)}
							disabled={i === formTargets.length - 1}
							title="Move down"
						>
							<ArrowDownIcon class="size-4" />
						</Button>
						<Button
							variant="outline"
							size="icon-sm"
							onclick={() => removeTarget(i)}
							disabled={formTargets.length <= 1}
							title="Remove target"
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
				<Button type="submit" disabled={formBusy}>
					{formBusy ? 'Saving…' : editingId ? 'Save mapping' : 'Add mapping'}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root open={deleteId !== null} onOpenChange={(open) => !open && (deleteId = null)}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Delete mapping?</Dialog.Title>
			<Dialog.Description>
				Proxy clients using this alias will fail with an unknown model error once it is gone.
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
