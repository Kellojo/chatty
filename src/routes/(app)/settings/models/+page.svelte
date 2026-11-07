<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { resolve } from '$app/paths';
	import BoxesIcon from '@lucide/svelte/icons/boxes';
	import CoinsIcon from '@lucide/svelte/icons/coins';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import SearchIcon from '@lucide/svelte/icons/search';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import SettingsHeader from '$lib/components/app/settings/SettingsHeader.svelte';
	import SettingsSection from '$lib/components/app/settings/SettingsSection.svelte';
	import SettingsListItem from '$lib/components/app/settings/SettingsListItem.svelte';
	import RowMenu from '$lib/components/app/settings/RowMenu.svelte';
	import { formatCount } from '$lib/formats.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import ProviderIcon from '$lib/components/app/ProviderIcon.svelte';
	import { resolveModelBrand, resolveProviderBrand } from '$lib/provider-brand.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	type Model = PageData['models'][number];
	type Capability = 'chat' | 'vision' | 'tool_use' | 'streaming' | 'image' | 'decisions';

	const allCapabilities: Capability[] = [
		'chat',
		'vision',
		'tool_use',
		'streaming',
		'image',
		'decisions'
	];

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
	let pricingContext = $state('');
	let pricingBusy = $state(false);

	let deleteId = $state<string | null>(null);
	let deleteBusy = $state(false);

	const providersById = $derived(new Map(data.providers.map((p) => [p.id, p])));

	let query = $state('');
	const needle = $derived(query.trim().toLowerCase());

	function modelsFor(providerId: string): Model[] {
		const models = data.models.filter((m) => m.providerId === providerId);
		if (!needle) return models;
		return models.filter(
			(m) =>
				m.displayName.toLowerCase().includes(needle) || m.modelId.toLowerCase().includes(needle)
		);
	}

	const enabledCount = $derived(data.models.filter((m) => m.enabled).length);
	const visibleProviders = $derived(
		needle ? data.providers.filter((p) => modelsFor(p.id).length > 0) : data.providers
	);

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
		pricingContext = model.contextLength !== null ? String(model.contextLength) : '';
	}

	function parsePrice(raw: string): number | null {
		const trimmed = raw.trim();
		if (trimmed === '') return null;
		const value = Number(trimmed);
		if (!Number.isFinite(value) || value < 0)
			throw new Error('Prices must be non-negative numbers');
		return value;
	}

	function parseContext(raw: string): number | null {
		const trimmed = raw.trim();
		if (trimmed === '') return null;
		const value = Number(trimmed);
		if (!Number.isInteger(value) || value <= 0)
			throw new Error('Context length must be a positive integer');
		return value;
	}

	async function submitPricing(event: SubmitEvent) {
		event.preventDefault();
		if (!pricingModel) return;
		pricingBusy = true;
		try {
			await api(`/api/models/${pricingModel.id}`, 'PATCH', {
				priceInput: parsePrice(pricingInput),
				priceOutput: parsePrice(pricingOutput),
				contextLength: parseContext(pricingContext)
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

<svelte:head><title>Models · Settings · Chatty</title></svelte:head>

<SettingsHeader title="Models">
	{#snippet description()}
		Models offered in the model picker. {enabledCount} of {data.models.length} enabled. Choose which one
		serves new chats, titles and memory in
		<a
			class="underline underline-offset-4 hover:text-foreground"
			href={resolve('/settings/defaults')}>Defaults</a
		>.
	{/snippet}
	{#snippet actions()}
		<Button onclick={() => (addOpen = true)} disabled={data.providers.length === 0}>
			<PlusIcon class="size-4" />Add model
		</Button>
	{/snippet}
</SettingsHeader>

{#if data.models.length > 8}
	<div class="relative">
		<SearchIcon
			class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
		/>
		<Input
			type="search"
			bind:value={query}
			placeholder="Search models"
			aria-label="Search models"
			class="pl-9"
		/>
	</div>
{/if}

{#each visibleProviders as provider (provider.id)}
	{@const models = modelsFor(provider.id)}
	{@const providerBrand = resolveProviderBrand(provider)}
	<SettingsSection
		title={provider.name}
		description={provider.enabled
			? `${models.filter((m) => m.enabled).length} of ${models.length} enabled`
			: 'Provider disabled, so its models are hidden from the picker.'}
		flush
		class={provider.enabled ? '' : 'opacity-70'}
	>
		{#snippet icon()}
			{#if providerBrand}<ProviderIcon brand={providerBrand} class="size-4 shrink-0" />{/if}
		{/snippet}
		{#if models.length === 0}
			<p class="px-6 pb-4 text-sm text-muted-foreground">
				No models yet. Use “Fetch models” on
				<a class="underline underline-offset-4" href={resolve('/settings/providers')}>Providers</a>
				or add one manually.
			</p>
		{:else}
			<ul
				class="divide-y divide-border/60 border-t border-border/60"
				aria-label="{provider.name} models"
			>
				{#each models as model (model.id)}
					{@const brand = resolveModelBrand(model, provider)}
					<SettingsListItem title={model.displayName} muted={!model.enabled}>
						{#snippet leading()}
							{#if brand}<ProviderIcon {brand} class="size-4" />{:else}<BoxesIcon
									class="size-4"
								/>{/if}
						{/snippet}
						{#snippet meta()}
							<span class="font-mono" title={model.modelId}>{model.modelId}</span>
						{/snippet}
						<div class="mt-1 flex flex-wrap items-center gap-1">
							{#each model.capabilities as cap (cap)}
								<Badge variant="secondary" class="font-normal">{cap}</Badge>
							{/each}
							<span
								class="ml-1 text-xs text-muted-foreground tabular-nums"
								title="Input / output price per 1M tokens (USD)"
							>
								{formatPrice(model)}{#if model.contextLength !== null}
									· {formatCount(model.contextLength)} context{/if}
							</span>
						</div>
						{#snippet trailing()}
							<Switch
								checked={model.enabled}
								aria-label="Enable {model.displayName}"
								onCheckedChange={(checked) =>
									patch(model.id, { enabled: checked }, 'Model updated')}
							/>
							<RowMenu
								label="Actions for {model.displayName}"
								items={[
									{ label: 'Capabilities', icon: SparklesIcon, onSelect: () => openCaps(model) },
									{
										label: 'Pricing & context',
										icon: CoinsIcon,
										onSelect: () => openPricing(model)
									},
									'separator',
									{
										label: 'Delete',
										icon: Trash2Icon,
										destructive: true,
										onSelect: () => (deleteId = model.id)
									}
								]}
							/>
						{/snippet}
					</SettingsListItem>
				{/each}
			</ul>
		{/if}
	</SettingsSection>
{:else}
	<SettingsSection>
		<div class="flex flex-col items-center gap-3 py-6 text-center">
			<div
				class="flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground"
			>
				<BoxesIcon class="size-5" />
			</div>
			{#if needle}
				<p class="text-sm text-muted-foreground">No models match “{query.trim()}”.</p>
			{:else}
				<div class="flex flex-col gap-1">
					<p class="text-sm font-medium">No providers yet</p>
					<p class="text-sm text-muted-foreground">Add a provider first, then fetch its models.</p>
				</div>
				<Button size="sm" href={resolve('/settings/providers')}>Go to providers</Button>
			{/if}
		</div>
	</SettingsSection>
{/each}

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
							{@const brand = resolveProviderBrand(provider)}
							<Select.Item value={provider.id} label={provider.name}>
								{#if brand}<ProviderIcon {brand} class="size-3.5 shrink-0" />{/if}
								{provider.name}
							</Select.Item>
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
			<Dialog.Title>Pricing &amp; context — {pricingModel?.displayName}</Dialog.Title>
			<Dialog.Description>
				USD per 1M tokens. Leave empty when unknown; cost is only reported when both prices are set.
				Context length drives automatic chat compaction; providers like OpenRouter fill it on fetch.
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
			<div class="flex flex-col gap-2">
				<Label for="price-context">Context length (tokens)</Label>
				<Input
					id="price-context"
					bind:value={pricingContext}
					type="number"
					min="1"
					step="1"
					placeholder="e.g. 200000"
				/>
			</div>
			<Dialog.Footer>
				<Button type="submit" disabled={pricingBusy}>
					{pricingBusy ? 'Saving…' : 'Save'}
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
