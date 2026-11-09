<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { resolve } from '$app/paths';
	import BoxesIcon from '@lucide/svelte/icons/boxes';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import CoinsIcon from '@lucide/svelte/icons/coins';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import SearchIcon from '@lucide/svelte/icons/search';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import ToggleLeftIcon from '@lucide/svelte/icons/toggle-left';
	import ToggleRightIcon from '@lucide/svelte/icons/toggle-right';
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
	import { MODEL_ROLE_LABEL } from '$lib/model-roles.js';
	import type { ModelRole } from '$lib/types.js';
	import { formatCount } from '$lib/formats.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import ProviderIcon from '$lib/components/app/ProviderIcon.svelte';
	import { resolveModelBrand, resolveProviderBrand } from '$lib/provider-brand.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	type Model = PageData['models'][number];
	type Capability =
		'chat' | 'vision' | 'tool_use' | 'streaming' | 'image' | 'decisions' | 'transcription';

	const CAPABILITY_LABEL: Record<Capability, string> = {
		chat: 'Chat',
		vision: 'Vision (image input)',
		tool_use: 'Tool use',
		streaming: 'Streaming',
		image: 'Image generation',
		decisions: 'Decisions API',
		transcription: 'Speech to text'
	};
	const allCapabilities = Object.keys(CAPABILITY_LABEL) as Capability[];
	const capLabel = (cap: string) => CAPABILITY_LABEL[cap as Capability] ?? cap;

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
	let pricingCacheRead = $state('');
	let pricingCacheWrite = $state('');
	let pricingContext = $state('');
	let pricingBusy = $state(false);

	let deleteId = $state<string | null>(null);
	let deleteBusy = $state(false);

	const providersById = $derived(new Map(data.providers.map((p) => [p.id, p])));

	let query = $state('');
	const needle = $derived(query.trim().toLowerCase());

	type StatusFilter = 'all' | 'enabled' | 'disabled';
	let status = $state<StatusFilter>('all');
	const filtering = $derived(needle !== '' || status !== 'all');

	/** Long provider lists start collapsed; searching or filtering shows every match. */
	const COLLAPSED_ROWS = 25;
	let expanded = $state<Record<string, boolean>>({});

	/** Capabilities nearly every model has; listing them on each row is noise. */
	const COMMON_CAPS: ReadonlySet<string> = new Set<Capability>(['chat', 'streaming']);

	function modelsFor(providerId: string): Model[] {
		return data.models.filter(
			(m) =>
				m.providerId === providerId &&
				(status === 'all' || m.enabled === (status === 'enabled')) &&
				(!needle ||
					m.displayName.toLowerCase().includes(needle) ||
					m.modelId.toLowerCase().includes(needle))
		);
	}

	const enabledCount = $derived(data.models.filter((m) => m.enabled).length);
	const visibleProviders = $derived(
		filtering ? data.providers.filter((p) => modelsFor(p.id).length > 0) : data.providers
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

	let bulkBusy = $state<string | null>(null);

	/** Model id → the Defaults purposes it serves. */
	const rolesByModel = $derived.by(() => {
		const byModel: Record<string, string[]> = {};
		for (const [role, id] of Object.entries(data.roleDefaults) as [ModelRole, string][]) {
			(byModel[id] ??= []).push(MODEL_ROLE_LABEL[role]);
		}
		return byModel;
	});
	const defaultIds = $derived(new Set(Object.keys(rolesByModel)));

	/** Turns the listed models on or off; only touches rows that need it. Disabling skips
	 *  models picked in Defaults, since that would break the feature they serve. */
	async function setAllEnabled(providerId: string, list: Model[], enabled: boolean) {
		if (bulkBusy) {
			toast.info('Wait for the current update to finish.');
			return;
		}
		const targets = list.filter((m) => m.enabled !== enabled && (enabled || !defaultIds.has(m.id)));
		const kept = enabled ? 0 : list.filter((m) => m.enabled && defaultIds.has(m.id)).length;
		const plural = (n: number) => `${n} model${n === 1 ? '' : 's'}`;
		if (targets.length === 0) {
			if (kept > 0)
				toast.info(`Only models used in Defaults are left on; change them in Defaults first.`);
			return;
		}
		if (
			!enabled &&
			!confirm(
				`Disable ${plural(targets.length)}? They'll disappear from the model picker, and mappings that point at them will skip them.` +
					(kept > 0 ? ` ${plural(kept)} used in Defaults stay on.` : '')
			)
		)
			return;
		bulkBusy = providerId;
		const verb = enabled ? 'enabled' : 'disabled';
		const toastId = toast.loading(
			`${enabled ? 'Enabling' : 'Disabling'} ${plural(targets.length)}…`
		);
		let failed = 0;
		const queue = [...targets];
		const worker = async () => {
			for (let m = queue.shift(); m; m = queue.shift()) {
				await api(`/api/models/${m.id}`, 'PATCH', { enabled }).catch(() => failed++);
			}
		};
		try {
			await Promise.all(Array.from({ length: 6 }, worker));
			await invalidateAll();
			const done = targets.length - failed;
			if (failed > 0) {
				toast.error(`${plural(done)} ${verb}, ${failed} failed`, { id: toastId });
			} else {
				toast.success(`${plural(done)} ${verb}`, {
					id: toastId,
					action: {
						label: `Undo (${targets.length})`,
						onClick: () =>
							setAllEnabled(
								providerId,
								targets.map((m) => ({ ...m, enabled })),
								!enabled
							)
					}
				});
			}
		} finally {
			bulkBusy = null;
		}
	}

	function setEnabled(model: Model, enabled: boolean) {
		if (
			!enabled &&
			defaultIds.has(model.id) &&
			!confirm(
				`${model.displayName} is used in Defaults for: ${rolesByModel[model.id]?.join(', ')}. Disable it anyway?`
			)
		)
			return;
		patch(model.id, { enabled }, `${model.displayName} ${enabled ? 'enabled' : 'disabled'}`);
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
			// Keep anything this dialog doesn't list, so saving never drops it.
			const unlisted = capsModel.capabilities.filter(
				(c) => !allCapabilities.includes(c as Capability)
			);
			await api(`/api/models/${capsModel.id}`, 'PATCH', {
				capabilities: [...capsSelected, ...unlisted]
			});
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
		pricingCacheRead = model.priceCacheRead !== null ? String(model.priceCacheRead) : '';
		pricingCacheWrite = model.priceCacheWrite !== null ? String(model.priceCacheWrite) : '';
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
				priceCacheRead: parsePrice(pricingCacheRead),
				priceCacheWrite: parsePrice(pricingCacheWrite),
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

	/** Secondary line: the API id (when it differs from the name), price and context window. */
	function modelDetails(model: Model): { text: string; title?: string; mono?: boolean }[] {
		const parts: { text: string; title?: string; mono?: boolean }[] = [];
		if (model.modelId !== model.displayName) parts.push({ text: model.modelId, mono: true });
		if (model.priceInput !== null || model.priceOutput !== null) {
			const input = model.priceInput !== null ? formatUsdPerMillion(model.priceInput) : '?';
			const output = model.priceOutput !== null ? formatUsdPerMillion(model.priceOutput) : '?';
			parts.push({
				text: `${input} / ${output} per 1M`,
				title: 'Input / output price per 1M tokens (USD)'
			});
		}
		if (model.contextLength !== null) {
			parts.push({ text: `${formatCount(model.contextLength)} context` });
		}
		return parts;
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
		Models offered in the model picker.{#if data.providers.length > 1}
			{enabledCount} of {data.models.length} enabled.{/if}
		<span class="max-md:hidden"
			>Pick the model for each purpose (chat, titles, memory, images…) in
			<a
				class="underline underline-offset-4 hover:text-foreground"
				href={resolve('/settings/defaults')}>Defaults</a
			>.</span
		>
	{/snippet}
	{#snippet actions()}
		<!-- Without providers the empty state points to Providers instead. -->
		{#if data.providers.length > 0}
			<Button onclick={() => (addOpen = true)}>
				<PlusIcon class="size-4" />Add model
			</Button>
		{/if}
	{/snippet}
</SettingsHeader>

{#if data.models.length > 8}
	<div class="flex flex-col gap-2 sm:flex-row sm:items-center">
		<div class="relative min-w-0 flex-1">
			<SearchIcon
				class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
			/>
			<Input
				type="search"
				bind:value={query}
				placeholder="Search models"
				aria-label="Search models"
				class="h-9 pl-9"
			/>
		</div>
		<div
			class="flex h-9 shrink-0 items-stretch self-start rounded-full border p-0.5 sm:self-auto"
			role="group"
			aria-label="Show"
		>
			{#each [['all', 'All'], ['enabled', 'Enabled'], ['disabled', 'Disabled']] as [value, label] (value)}
				<button
					type="button"
					class="rounded-full px-3 text-xs {status === value
						? 'bg-accent font-medium text-accent-foreground'
						: 'text-muted-foreground hover:text-foreground'}"
					aria-pressed={status === value}
					onclick={() => (status = value as StatusFilter)}
				>
					{label}
				</button>
			{/each}
		</div>
	</div>
{/if}

{#each visibleProviders as provider (provider.id)}
	{@const models = modelsFor(provider.id)}
	{@const collapsed = !filtering && !expanded[provider.id] && models.length > COLLAPSED_ROWS}
	{@const shown = collapsed ? models.slice(0, COLLAPSED_ROWS) : models}
	{@const providerBrand = resolveProviderBrand(provider)}
	{@const showBrandIcons = models.some((m) => resolveModelBrand(m, provider) !== providerBrand)}
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
		{#snippet action()}
			{#if models.length > 1}
				{@const scope = filtering ? `${models.length} shown` : 'all'}
				{@const busy = bulkBusy !== null}
				<RowMenu
					text="Bulk actions"
					label="Bulk actions for {provider.name} models"
					items={[
						{
							label: `Enable ${scope}`,
							icon: ToggleRightIcon,
							disabled: busy || models.every((m) => m.enabled),
							onSelect: () => setAllEnabled(provider.id, models, true)
						},
						{
							label: `Disable ${scope}`,
							icon: ToggleLeftIcon,
							disabled: busy || models.every((m) => !m.enabled || defaultIds.has(m.id)),
							onSelect: () => setAllEnabled(provider.id, models, false)
						}
					]}
				/>
			{/if}
		{/snippet}
		{#if models.length === 0}
			<p class="px-6 pb-4 text-sm text-muted-foreground">
				No models yet. Use “Sync models” on
				<a class="underline underline-offset-4" href={resolve('/settings/providers')}>Providers</a>
				or add one manually.
			</p>
		{:else}
			<ul
				class="divide-y divide-border/60 border-t border-border/60"
				aria-label="{provider.name} models"
			>
				{#each shown as model (model.id)}
					{@const brand = resolveModelBrand(model, provider)}
					{@const details = modelDetails(model)}
					{@const caps = model.capabilities.filter((c) => !COMMON_CAPS.has(c))}
					<!-- "vendor/model" ids may wrap after the slash, never mid-name. -->
					{@const title = model.displayName.replace('/', '/' + String.fromCharCode(0x200b))}
					{#snippet modelIcon()}
						{#if brand !== providerBrand}
							{#if brand}<ProviderIcon {brand} class="size-4" />{:else}<BoxesIcon
									class="size-4"
								/>{/if}
						{/if}
					{/snippet}
					{#snippet modelMeta()}
						<!-- Each separator travels with the part after it (nowrap), so a wrapped line
							     never ends on a dangling dot; <wbr> marks the only break points. -->
						{#each details as part, i (i)}{#if i > 0}<wbr />{/if}<span
								class="whitespace-nowrap {i > 0 ? 'ml-1' : ''} {part.mono
									? 'font-mono'
									: 'tabular-nums'}"
								title={part.title}
								>{#if i > 0}<span class="mr-1" aria-hidden="true">·</span>{/if}{part.text}</span
							>{/each}{#if caps.length > 0}<wbr /><span
								class="sm:hidden {details.length > 0 ? 'ml-1' : ''}"
								>{#if details.length > 0}<span class="mr-1" aria-hidden="true">·</span>{/if}{caps
									.map(capLabel)
									.join(', ')}</span
							>{/if}
					{/snippet}
					<SettingsListItem
						{title}
						titleAttr={model.modelId}
						onclick={() => openCaps(model)}
						muted={!model.enabled}
						leading={showBrandIcons ? modelIcon : undefined}
						meta={details.length > 0 ? modelMeta : undefined}
					>
						{#snippet badges()}
							{#if defaultIds.has(model.id)}
								<Badge
									variant="outline"
									class="font-normal"
									title="Used in Defaults for: {rolesByModel[model.id]?.join(', ')}"
									>In Defaults</Badge
								>
							{/if}
							{#each caps as cap (cap)}
								<!-- Phones: chips wrapped rows to double height, so a meta line lists them
									instead. Without a meta line there's nothing to wrap under, so keep the chips. -->
								<Badge
									variant="secondary"
									class="font-normal {details.length > 0 ? 'max-sm:hidden' : ''}"
									>{capLabel(cap)}</Badge
								>
							{/each}
						{/snippet}
						{#snippet trailing()}
							<Switch
								checked={model.enabled}
								aria-label="Enable {model.displayName}"
								onCheckedChange={(checked) => setEnabled(model, checked)}
							/>
							<RowMenu
								label="Actions for {model.displayName}"
								items={[
									{
										label: 'Edit capabilities',
										icon: SparklesIcon,
										onSelect: () => openCaps(model)
									},
									{
										label: 'Edit pricing & context',
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
			{#if collapsed}
				<div class="border-t border-border/60 px-6 pt-2">
					<Button
						variant="ghost"
						size="sm"
						class="-ml-2.5"
						onclick={() => (expanded[provider.id] = true)}
					>
						<ChevronDownIcon class="size-4" />
						Show all {models.length}
					</Button>
				</div>
			{/if}
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
			{#if filtering}
				<p class="text-sm text-muted-foreground">
					{#if needle}No {status === 'all' ? '' : `${status} `}models match “{query.trim()}”.{:else}No
						{status} models.{/if}
				</p>
			{:else}
				<div class="flex flex-col gap-1">
					<p class="text-sm font-medium">No providers yet</p>
					<p class="text-sm text-muted-foreground">Add a provider first, then sync its models.</p>
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
				<Button type="button" variant="outline" onclick={() => (addOpen = false)}>Cancel</Button>
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
			<Dialog.Title>Edit capabilities · {capsModel?.displayName}</Dialog.Title>
			<Dialog.Description>
				Vision enables image attachments; tool use is required for MCP tools. Image generation,
				Decisions API and Speech to text make the model selectable for that role in Defaults.
			</Dialog.Description>
		</Dialog.Header>
		<div class="flex flex-col gap-3">
			{#each allCapabilities as cap (cap)}
				<label class="flex items-center gap-3 text-sm">
					<Switch checked={capsSelected.includes(cap)} onCheckedChange={() => toggleCap(cap)} />
					{CAPABILITY_LABEL[cap]}
				</label>
			{/each}
		</div>
		<Dialog.Footer>
			{#if capsModel}
				{@const model = capsModel}
				<Button
					variant="ghost"
					class="sm:mr-auto"
					onclick={() => {
						capsModel = null;
						openPricing(model);
					}}>Pricing &amp; context…</Button
				>
			{/if}
			<Button variant="outline" onclick={() => (capsModel = null)}>Cancel</Button>
			<Button disabled={capsBusy} onclick={submitCaps}>
				{capsBusy ? 'Saving…' : 'Save changes'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root open={pricingModel !== null} onOpenChange={(open) => !open && (pricingModel = null)}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Edit pricing &amp; context · {pricingModel?.displayName}</Dialog.Title>
			<Dialog.Description>
				USD per 1M tokens. Leave empty when unknown; cost is only reported when both prices are set.
				Cached prompt tokens use the input price unless a cache price is set. Context length drives
				automatic chat compaction; providers like OpenRouter fill it when you sync models.
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
			<div class="grid grid-cols-2 gap-4">
				<div class="flex flex-col gap-2">
					<Label for="price-cache-read">Cache read price</Label>
					<Input
						id="price-cache-read"
						bind:value={pricingCacheRead}
						type="number"
						min="0"
						step="any"
						placeholder="= input price"
					/>
				</div>
				<div class="flex flex-col gap-2">
					<Label for="price-cache-write">Cache write price</Label>
					<Input
						id="price-cache-write"
						bind:value={pricingCacheWrite}
						type="number"
						min="0"
						step="any"
						placeholder="= input price"
					/>
				</div>
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
				<Button type="button" variant="outline" onclick={() => (pricingModel = null)}>Cancel</Button
				>
				<Button type="submit" disabled={pricingBusy}>
					{pricingBusy ? 'Saving…' : 'Save changes'}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root open={deleteId !== null} onOpenChange={(open) => !open && (deleteId = null)}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title
				>Delete {data.models.find((m) => m.id === deleteId)?.displayName ?? 'model'}?</Dialog.Title
			>
			<Dialog.Description>
				Conversations that used this model keep their history but cannot continue with it. Synced
				models come back on the next sync; to hide one, turn it off instead.
				{#if deleteId && rolesByModel[deleteId]}
					It's used in Defaults for {rolesByModel[deleteId].join(', ')}, which will be left without
					a model.
				{/if}
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
