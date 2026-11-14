<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { resolve } from '$app/paths';
	import BoxesIcon from '@lucide/svelte/icons/boxes';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import CoinsIcon from '@lucide/svelte/icons/coins';
	import StarIcon from '@lucide/svelte/icons/star';
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
	import ModelEditDialog, {
		type ModelEditTab
	} from '$lib/components/app/settings/models/ModelEditDialog.svelte';
	import {
		capabilityIcon,
		capabilityLabel
	} from '$lib/components/app/settings/models/capabilities.js';
	import ArtificialAnalysisFooter from '$lib/components/app/settings/ArtificialAnalysisFooter.svelte';
	import { MODEL_ROLE_LABEL } from '$lib/model-roles.js';
	import type { ModelRole } from '$lib/types.js';
	import { formatCount } from '$lib/formats.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import ProviderIcon from '$lib/components/app/ProviderIcon.svelte';
	import { resolveBrand, resolveProviderBrand, type Brand } from '$lib/provider-brand.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	type Model = PageData['models'][number];

	let addOpen = $state(false);
	let addProviderId = $state('');
	let addModelId = $state('');
	let addDisplayName = $state('');
	let addBusy = $state(false);

	/** The model in the edit dialog, and which tab it opened on. */
	let editModel = $state<Model | null>(null);
	let editTab = $state<ModelEditTab>('capabilities');
	function openEdit(model: Model, tab: ModelEditTab = 'capabilities') {
		editTab = tab;
		editModel = model;
	}
	const editVisual = $derived.by(() => {
		if (!editModel) return null;
		const provider = providersById.get(editModel.providerId);
		const visual = modelName(editModel);
		const providerBrand = provider ? resolveProviderBrand(provider) : null;
		return { ...visual, brand: visual.brand ?? (visual.maker ? null : providerBrand) };
	});

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
	const COMMON_CAPS: ReadonlySet<string> = new Set(['chat', 'streaming']);

	/** Artificial Analysis Intelligence Index scores; empty without an API key. */
	const hasScores = $derived(Object.keys(data.scores).length > 0);
	const maxScore = $derived(Math.max(1, ...Object.values(data.scores).map((s) => s.index)));
	const formatScore = (index: number) => index.toFixed(1);

	type SortKey = 'name' | 'intelligence';
	let sort = $state<SortKey>('name');

	function modelsFor(providerId: string): Model[] {
		const list = data.models.filter(
			(m) =>
				m.providerId === providerId &&
				(status === 'all' || m.enabled === (status === 'enabled')) &&
				(!needle ||
					m.displayName.toLowerCase().includes(needle) ||
					m.modelId.toLowerCase().includes(needle))
		);
		if (sort !== 'intelligence' || !hasScores) return list;
		// Best first; unscored models keep their name order at the end.
		const score = (m: Model) => data.scores[m.id]?.index ?? -1;
		return [...list].sort((a, b) => score(b) - score(a));
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

	/** Company names for the brands that are also model makers ("anthropic/…" reads as Anthropic). */
	const MAKER_LABEL: Partial<Record<Brand, string>> = {
		claude: 'Anthropic',
		openai: 'OpenAI',
		gemini: 'Google',
		grok: 'xAI',
		deepseek: 'DeepSeek',
		mistral: 'Mistral',
		qwen: 'Qwen',
		meta: 'Meta'
	};

	/** "vendor/model" ids read as the model's name, with the vendor moved to the line below. */
	function modelName(model: Model): { name: string; maker: string | null; brand: Brand | null } {
		const slash = model.displayName.lastIndexOf('/');
		const name = slash > 0 ? model.displayName.slice(slash + 1) : model.displayName;
		const vendor = slash > 0 ? model.displayName.slice(0, slash) : null;
		// The vendor prefix wins over the name: "aion-labs/aion-rp-llama" is by aion-labs, not Meta.
		const brand = vendor ? resolveBrand(`${vendor}/`) : resolveBrand(model.modelId, name);
		const maker = (brand && MAKER_LABEL[brand]) ?? vendor;
		return { name, maker, brand };
	}

	/** Stand-in for makers without a brand icon: initials for multi-word names ("aion-labs" →
	 *  "AL"), the first three letters for one word ("alibaba" → "ALI"), so the two differ. */
	function monogram(maker: string): string {
		const words = maker.split(/[\s_.-]+/).filter(Boolean);
		if (words.length > 1) return (words[0][0] + words[1][0]).toUpperCase();
		return maker.slice(0, 3).toUpperCase();
	}

	/** Stable hue per maker; the golden-angle step spreads similar names around the wheel. */
	function makerHue(maker: string): number {
		let hash = 0;
		for (const char of maker) hash = (hash * 31 + char.charCodeAt(0)) | 0;
		return Math.round((Math.abs(hash) * 137.508) % 360);
	}

	/** Capability icons shown per row; the rest collapse into "+n". */
	const MAX_CAP_ICONS = 3;

	function formatUsd(value: number): string {
		if (value === 0) return '$0';
		return value < 0.01 ? `$${Number(value.toPrecision(2))}` : `$${value.toFixed(2)}`;
	}

	function priceText(model: Model): string | null {
		if (model.priceInput === null && model.priceOutput === null) return null;
		if (model.priceInput === 0 && model.priceOutput === 0) return 'Free';
		const input = model.priceInput !== null ? formatUsd(model.priceInput) : '?';
		const output = model.priceOutput !== null ? formatUsd(model.priceOutput) : '?';
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

<!-- The maker's mark, else a tinted monogram of the maker, else a generic glyph. -->
{#snippet modelTile(brand: Brand | null, maker: string | null)}
	{#if brand}<ProviderIcon {brand} decorative class="size-5" />{:else if maker}<span
			class="flex size-full items-center justify-center rounded-lg bg-[oklch(0.6_0.12_var(--hue)/0.14)] text-[10px] font-bold tracking-wide text-[oklch(0.5_0.14_var(--hue))] ring-1 ring-[oklch(0.6_0.12_var(--hue)/0.25)] ring-inset dark:text-[oklch(0.86_0.1_var(--hue))]"
			style="--hue: {makerHue(maker)}"
			aria-hidden="true">{monogram(maker)}</span
		>{:else}<BoxesIcon class="size-4 opacity-70" />{/if}
{/snippet}

{#snippet notReported()}
	<span class="text-muted-foreground/70" aria-hidden="true">—</span><span class="sr-only"
		>Not reported</span
	>
{/snippet}

<SettingsHeader title="Models">
	{#snippet description()}
		Models offered in the model picker. {#if data.providers.length > 1}{enabledCount} of {data
				.models.length} enabled.{/if}
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
		{#if hasScores}
			<div
				class="flex h-9 shrink-0 items-stretch self-start rounded-full border p-0.5 sm:self-auto"
				role="group"
				aria-label="Sort by"
			>
				{#each [['name', 'Name'], ['intelligence', 'Intelligence']] as [value, label] (value)}
					<button
						type="button"
						class="rounded-full px-3 text-xs {sort === value
							? 'bg-accent font-medium text-accent-foreground'
							: 'text-muted-foreground hover:text-foreground'}"
						aria-pressed={sort === value}
						onclick={() => (sort = value as SortKey)}
					>
						{label}
					</button>
				{/each}
			</div>
		{/if}
	</div>
{/if}

{#each visibleProviders as provider (provider.id)}
	{@const models = modelsFor(provider.id)}
	{@const collapsed = !filtering && !expanded[provider.id] && models.length > COLLAPSED_ROWS}
	{@const shown = collapsed ? models.slice(0, COLLAPSED_ROWS) : models}
	{@const providerBrand = resolveProviderBrand(provider)}
	<!-- Context and price columns only for providers that report them (local servers don't). -->
	{@const showContext = models.some((m) => m.contextLength !== null)}
	{@const showPrice = models.some((m) => priceText(m) !== null)}
	{@const showScore = models.some((m) => data.scores[m.id])}
	{@const showStats = showContext || showPrice || showScore}
	<SettingsSection
		title={provider.name}
		description={provider.enabled
			? `${models.filter((m) => m.enabled).length} of ${models.length} enabled`
			: 'Provider disabled, so its models are hidden from the picker.'}
		flush
		class="{provider.enabled ? '' : 'opacity-70'} {showStats ? 'overflow-visible' : ''}"
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
			{#if showStats}
				<!-- Column labels; mirrors the row's trailing layout (stats, switch, menu). -->
				<div
					class="sticky top-0 z-20 flex items-center gap-2 border-b border-border/60 bg-card px-(--card-spacing) py-1.5 text-xs font-medium text-foreground/70 max-sm:hidden"
					aria-hidden="true"
				>
					<span class="flex-1"></span>
					<span class="mr-4 flex gap-4">
						{#if showScore}<span
								class="w-20 text-right"
								title="Artificial Analysis Intelligence Index">Intelligence</span
							>{/if}
						{#if showContext}<span class="w-16 text-right">Context</span>{/if}
						{#if showPrice}<span class="w-28 text-right" title="Input / output, USD"
								>Price / 1M tokens</span
							>{/if}
					</span>
					<span class="w-11"></span>
					<span class="w-8"></span>
				</div>
			{/if}
			<!-- The column header carries the top edge on desktop. -->
			<ul
				class="divide-y divide-border/60 border-t border-border/60 {showStats
					? 'sm:border-t-0'
					: ''}"
				aria-label="{provider.name} models"
			>
				{#each shown as model (model.id)}
					{@const { name, maker, brand: makerBrand } = modelName(model)}
					<!-- The maker's mark, else its monogram; the provider's mark only when the maker is unknown. -->
					{@const brand = makerBrand ?? (maker ? null : providerBrand)}
					{@const price = priceText(model)}
					{@const context = model.contextLength !== null ? formatCount(model.contextLength) : null}
					{@const caps = model.capabilities.filter((c) => !COMMON_CAPS.has(c))}
					<!-- On phones the stat columns become a short line under the maker. -->
					{@const score = data.scores[model.id]}
					{@const mobileStats = [
						score && `AAI ${formatScore(score.index)}`,
						context && `${context} ctx`,
						price
					]
						.filter(Boolean)
						.join(' · ')}
					{#snippet modelIcon()}{@render modelTile(brand, maker)}{/snippet}
					{#snippet modelMeta()}
						{#if maker}<span class="block truncate">{maker}</span>{/if}{#if mobileStats}<span
								class="block truncate tabular-nums sm:hidden"
								title="Context window · USD per 1M tokens, input / output">{mobileStats}</span
							>{/if}
					{/snippet}
					<SettingsListItem
						title={name}
						titleAttr={model.modelId}
						onclick={() => openEdit(model)}
						muted={!model.enabled}
						leading={modelIcon}
						meta={maker || mobileStats ? modelMeta : undefined}
					>
						{#snippet badges()}
							{#if caps.length > 0}
								<span class="flex items-center gap-1.5 text-muted-foreground/80">
									{#each caps.slice(0, MAX_CAP_ICONS) as cap (cap)}
										{@const Icon = capabilityIcon(cap)}
										{#if Icon}
											<span title={capabilityLabel(cap)}
												><Icon class="size-3.5" /><span class="sr-only">{capabilityLabel(cap)}</span
												></span
											>
										{:else}
											<Badge variant="secondary" class="font-normal">{capabilityLabel(cap)}</Badge>
										{/if}
									{/each}
									{#if caps.length > MAX_CAP_ICONS}
										{@const rest = caps.slice(MAX_CAP_ICONS).map(capabilityLabel).join(', ')}
										<span class="text-[11px] font-medium" title={rest}
											>+{caps.length - MAX_CAP_ICONS}<span class="sr-only">: {rest}</span></span
										>
									{/if}
								</span>
							{/if}
							{#if defaultIds.has(model.id)}
								<Badge
									variant="outline"
									class="border-primary/30 font-normal text-primary"
									title="Used in Defaults for: {rolesByModel[model.id]?.join(', ')}"
									><StarIcon class="size-3" />Default</Badge
								>
							{/if}
						{/snippet}
						{#snippet trailing()}
							{#if showStats}
								<span
									class="mr-4 flex gap-4 text-xs text-muted-foreground tabular-nums max-sm:hidden"
								>
									{#if showScore}
										<span
											class="flex w-20 items-center justify-end gap-1.5"
											title={score
												? `Artificial Analysis Intelligence Index · matched to ${score.aaName}`
												: 'No Artificial Analysis score found for this model'}
										>
											{#if score}
												<!-- Bar relative to the best score on the page, for a quick ranking read. -->
												<span
													class="h-1 w-6 overflow-hidden rounded-full bg-muted"
													aria-hidden="true"
													><span
														class="block h-full rounded-full bg-primary/60"
														style="width: {Math.round((score.index / maxScore) * 100)}%"
													></span></span
												>
												<span class="font-medium text-foreground/80"
													>{formatScore(score.index)}</span
												>
											{:else}{@render notReported()}{/if}
										</span>
									{/if}
									{#if showContext}
										<span class="w-16 text-right" title="Context window (tokens)"
											>{#if context}{context}{:else}{@render notReported()}{/if}</span
										>
									{/if}
									{#if showPrice}
										<span
											class="w-28 text-right"
											title={price && price !== 'Free'
												? `${price.replace(' / ', ' in / ')} out per 1M tokens (USD)`
												: 'USD per 1M tokens, input / output'}
											>{#if price}{price}{:else}{@render notReported()}{/if}</span
										>
									{/if}
								</span>
							{/if}
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
										onSelect: () => openEdit(model, 'capabilities')
									},
									{
										label: 'Edit pricing & context',
										icon: CoinsIcon,
										onSelect: () => openEdit(model, 'pricing')
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

{#if data.providers.length > 0}
	<ArtificialAnalysisFooter aa={data.aa} />
{/if}

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

{#if editVisual}
	{@const visual = editVisual}
	{#snippet editIcon()}{@render modelTile(visual.brand, visual.maker)}{/snippet}
	<ModelEditDialog
		model={editModel}
		bind:tab={editTab}
		name={visual.name}
		maker={visual.maker}
		icon={editIcon}
		onClose={() => (editModel = null)}
	/>
{/if}

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
