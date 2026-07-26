<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	type Model = PageData['models'][number];
	type Capability = 'chat' | 'vision' | 'tool_use' | 'streaming' | 'image';

	const allCapabilities: Capability[] = ['chat', 'vision', 'tool_use', 'streaming', 'image'];

	let addOpen = $state(false);
	let addProviderId = $state('');
	let addModelId = $state('');
	let addDisplayName = $state('');
	let addBusy = $state(false);

	let capsModel = $state<Model | null>(null);
	let capsSelected = $state<Capability[]>([]);
	let capsBusy = $state(false);

	let pricingModel = $state<Model | null>(null);
	let pricingInput = $state('');
	let pricingOutput = $state('');
	let pricingBusy = $state(false);

	let deleteId = $state<string | null>(null);
	let deleteBusy = $state(false);

	const providersById = $derived(new Map(data.providers.map((p) => [p.id, p])));

	function modelsFor(providerId: string): Model[] {
		return data.models.filter((m) => m.providerId === providerId);
	}

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

	async function patch(id: string, body: unknown, successMessage: string) {
		try {
			await api(`/api/models/${id}`, 'PATCH', body);
			toast.success(successMessage);
			await invalidateAll();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to update model');
		}
	}

	async function submitAdd(event: SubmitEvent) {
		event.preventDefault();
		addBusy = true;
		try {
			await api('/api/models', 'POST', {
				providerId: addProviderId,
				modelId: addModelId,
				displayName: addDisplayName || undefined
			});
			toast.success(`Model "${addModelId}" added`);
			addOpen = false;
			addModelId = '';
			addDisplayName = '';
			await invalidateAll();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to add model');
		} finally {
			addBusy = false;
		}
	}

	function openCaps(model: Model) {
		capsModel = model;
		capsSelected = model.capabilities.filter((c): c is Capability =>
			allCapabilities.includes(c as Capability)
		);
	}

	function toggleCap(cap: Capability) {
		capsSelected = capsSelected.includes(cap)
			? capsSelected.filter((c) => c !== cap)
			: [...capsSelected, cap];
	}

	async function submitCaps() {
		if (!capsModel) return;
		capsBusy = true;
		try {
			await api(`/api/models/${capsModel.id}`, 'PATCH', { capabilities: capsSelected });
			toast.success('Capabilities updated');
			capsModel = null;
			await invalidateAll();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to update capabilities');
		} finally {
			capsBusy = false;
		}
	}

	function openPricing(model: Model) {
		pricingModel = model;
		pricingInput = model.priceInput !== null ? String(model.priceInput) : '';
		pricingOutput = model.priceOutput !== null ? String(model.priceOutput) : '';
	}

	function parsePrice(raw: string): number | null {
		const trimmed = raw.trim();
		if (trimmed === '') return null;
		const value = Number(trimmed);
		if (!Number.isFinite(value) || value < 0)
			throw new Error('Prices must be non-negative numbers');
		return value;
	}

	async function submitPricing(event: SubmitEvent) {
		event.preventDefault();
		if (!pricingModel) return;
		pricingBusy = true;
		try {
			await api(`/api/models/${pricingModel.id}`, 'PATCH', {
				priceInput: parsePrice(pricingInput),
				priceOutput: parsePrice(pricingOutput)
			});
			toast.success('Pricing updated');
			pricingModel = null;
			await invalidateAll();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to update pricing');
		} finally {
			pricingBusy = false;
		}
	}

	function formatUsdPerMillion(value: number): string {
		return `$${Number(value.toPrecision(6))}`;
	}

	function formatPrice(model: Model): string {
		if (model.priceInput === null && model.priceOutput === null) return '—';
		const input = model.priceInput !== null ? formatUsdPerMillion(model.priceInput) : '?';
		const output = model.priceOutput !== null ? formatUsdPerMillion(model.priceOutput) : '?';
		return `${input} / ${output}`;
	}

	async function confirmDelete() {
		if (!deleteId) return;
		deleteBusy = true;
		try {
			await api(`/api/models/${deleteId}`, 'DELETE');
			toast.success('Model deleted');
			deleteId = null;
			await invalidateAll();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to delete model');
		} finally {
			deleteBusy = false;
		}
	}
</script>

<div class="flex flex-col gap-4">
	<div class="flex items-center justify-between">
		<h2 class="text-xl font-semibold">Models</h2>
		<Button onclick={() => (addOpen = true)} disabled={data.providers.length === 0}>
			Add model
		</Button>
	</div>
	<p class="text-sm text-muted-foreground">
		To pick which model is used for new chats, title generation, memory, and image generation, see
		the Defaults page.
	</p>

	{#each data.providers as provider (provider.id)}
		{@const models = modelsFor(provider.id)}
		<Card.Root class={provider.enabled ? '' : 'opacity-60'}>
			<Card.Header>
				<Card.Title class="flex items-center gap-2">
					{provider.name}
					{#if !provider.enabled}<Badge variant="outline">disabled</Badge>{/if}
				</Card.Title>
			</Card.Header>
			<Card.Content>
				<Table.Root>
					<Table.Header>
						<Table.Row>
							<Table.Head>Display name</Table.Head>
							<Table.Head>Model ID</Table.Head>
							<Table.Head>Capabilities</Table.Head>
							<Table.Head>Price / 1M tok</Table.Head>
							<Table.Head>Enabled</Table.Head>
							<Table.Head class="text-right">Actions</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each models as model (model.id)}
							<Table.Row>
								<Table.Cell class="max-w-40 truncate font-medium" title={model.displayName}>
									{model.displayName}
								</Table.Cell>
								<Table.Cell class="max-w-48 truncate text-muted-foreground" title={model.modelId}>
									{model.modelId}
								</Table.Cell>
								<Table.Cell class="whitespace-normal">
									<div class="flex flex-wrap gap-1">
										{#each model.capabilities as cap (cap)}
											<Badge variant="secondary">{cap}</Badge>
										{/each}
									</div>
								</Table.Cell>
								<Table.Cell class="whitespace-nowrap text-muted-foreground">
									<span title="Input / output price per 1M tokens (USD)">{formatPrice(model)}</span>
								</Table.Cell>
								<Table.Cell>
									<Switch
										checked={model.enabled}
										onCheckedChange={(checked) =>
											patch(model.id, { enabled: checked }, 'Model updated')}
									/>
								</Table.Cell>
								<Table.Cell class="text-right whitespace-nowrap">
									<div class="flex justify-end">
										<DropdownMenu.Root>
											<DropdownMenu.Trigger>
												{#snippet child({ props })}
													<Button
														{...props}
														variant="ghost"
														size="icon-sm"
														title="Actions"
														aria-label="Actions"
													>
														<EllipsisIcon class="size-4" />
													</Button>
												{/snippet}
											</DropdownMenu.Trigger>
											<DropdownMenu.Content align="end">
												<DropdownMenu.Item onclick={() => openCaps(model)}>
													Capabilities
												</DropdownMenu.Item>
												<DropdownMenu.Item onclick={() => openPricing(model)}>
													Pricing
												</DropdownMenu.Item>
												<DropdownMenu.Separator />
												<DropdownMenu.Item
													variant="destructive"
													onclick={() => (deleteId = model.id)}
												>
													Delete
												</DropdownMenu.Item>
											</DropdownMenu.Content>
										</DropdownMenu.Root>
									</div>
								</Table.Cell>
							</Table.Row>
						{:else}
							<Table.Row>
								<Table.Cell colspan={6} class="text-center text-muted-foreground">
									No models. Use "Fetch models" on the Providers page or add one manually.
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			</Card.Content>
		</Card.Root>
	{:else}
		<p class="text-muted-foreground">No providers configured yet.</p>
	{/each}
</div>

<Dialog.Root bind:open={addOpen}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Add model</Dialog.Title>
			<Dialog.Description>Register a model entry manually.</Dialog.Description>
		</Dialog.Header>
		<form onsubmit={submitAdd} class="flex flex-col gap-4">
			<div class="flex flex-col gap-2">
				<Label>Provider</Label>
				<Select.Root type="single" bind:value={addProviderId}>
					<Select.Trigger class="w-full">
						{addProviderId ? providersById.get(addProviderId)?.name : 'Select a provider'}
					</Select.Trigger>
					<Select.Content>
						{#each data.providers as provider (provider.id)}
							<Select.Item value={provider.id}>{provider.name}</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
			</div>
			<div class="flex flex-col gap-2">
				<Label for="add-modelid">Model ID</Label>
				<Input id="add-modelid" bind:value={addModelId} required placeholder="claude-sonnet-4-5" />
			</div>
			<div class="flex flex-col gap-2">
				<Label for="add-displayname">Display name (optional)</Label>
				<Input id="add-displayname" bind:value={addDisplayName} />
			</div>
			<Dialog.Footer>
				<Button type="submit" disabled={addBusy || !addProviderId}>
					{addBusy ? 'Adding…' : 'Add model'}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root open={capsModel !== null} onOpenChange={(open) => !open && (capsModel = null)}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Capabilities — {capsModel?.displayName}</Dialog.Title>
			<Dialog.Description>
				Vision enables image attachments; tool use is required for MCP tools.
			</Dialog.Description>
		</Dialog.Header>
		<div class="flex flex-col gap-3">
			{#each allCapabilities as cap (cap)}
				<label class="flex items-center gap-3 text-sm">
					<Switch checked={capsSelected.includes(cap)} onCheckedChange={() => toggleCap(cap)} />
					{cap}
				</label>
			{/each}
		</div>
		<Dialog.Footer>
			<Button disabled={capsBusy} onclick={submitCaps}>
				{capsBusy ? 'Saving…' : 'Save capabilities'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root open={pricingModel !== null} onOpenChange={(open) => !open && (pricingModel = null)}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Pricing — {pricingModel?.displayName}</Dialog.Title>
			<Dialog.Description>
				USD per 1M tokens. Leave empty when unknown; cost is only reported when both prices are set.
				Providers like OpenRouter fill these automatically on fetch.
			</Dialog.Description>
		</Dialog.Header>
		<form onsubmit={submitPricing} class="flex flex-col gap-4">
			<div class="flex flex-col gap-2">
				<Label for="price-input">Input price</Label>
				<Input
					id="price-input"
					bind:value={pricingInput}
					type="number"
					min="0"
					step="any"
					placeholder="e.g. 0.15"
				/>
			</div>
			<div class="flex flex-col gap-2">
				<Label for="price-output">Output price</Label>
				<Input
					id="price-output"
					bind:value={pricingOutput}
					type="number"
					min="0"
					step="any"
					placeholder="e.g. 0.60"
				/>
			</div>
			<Dialog.Footer>
				<Button type="submit" disabled={pricingBusy}>
					{pricingBusy ? 'Saving…' : 'Save pricing'}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root open={deleteId !== null} onOpenChange={(open) => !open && (deleteId = null)}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Delete model?</Dialog.Title>
			<Dialog.Description>
				Conversations that used this model keep their history but cannot continue with it.
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
