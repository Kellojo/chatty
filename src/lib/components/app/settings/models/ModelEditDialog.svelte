<script lang="ts" module>
	export type ModelEditTab = 'capabilities' | 'pricing';

	/** The fields this dialog reads and writes. */
	export interface EditableModel {
		id: string;
		modelId: string;
		capabilities: string[];
		priceInput: number | null;
		priceOutput: number | null;
		priceCacheRead: number | null;
		priceCacheWrite: number | null;
		contextLength: number | null;
	}
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import { tick, untrack } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import * as Tabs from '$lib/components/ui/tabs/index.js';
	import { formatAge, formatCount } from '$lib/formats.js';
	import {
		CAPABILITY_GROUPS,
		isEditableCapability,
		type EditableCapability
	} from './capabilities.js';

	let {
		model,
		tab = $bindable('capabilities'),
		name,
		maker,
		icon,
		onClose
	}: {
		/** The model being edited; null closes the dialog. */
		model: EditableModel | null;
		tab?: ModelEditTab;
		/** Display name without the vendor prefix, and the maker shown under it. */
		name: string;
		maker: string | null;
		/** The model's tile from the list (brand icon or monogram). */
		icon: Snippet;
		onClose: () => void;
	} = $props();

	type PriceKey = 'priceInput' | 'priceOutput' | 'priceCacheRead' | 'priceCacheWrite';
	type FieldKey = PriceKey | 'contextLength';

	const PRICE_FIELDS: { key: PriceKey; label: string; placeholder: string }[] = [
		{ key: 'priceInput', label: 'Input', placeholder: '0.00' },
		{ key: 'priceOutput', label: 'Output', placeholder: '0.00' },
		{ key: 'priceCacheRead', label: 'Cache read', placeholder: 'Optional' },
		{ key: 'priceCacheWrite', label: 'Cache write', placeholder: 'Optional' }
	];
	/** Capabilities that only matter for a model you can chat with. */
	const NEEDS_CHAT: ReadonlySet<EditableCapability> = new Set(['streaming', 'vision', 'tool_use']);

	let caps = $state<EditableCapability[]>([]);
	let values = $state<Record<FieldKey, string>>(emptyValues());
	let initial = $state('');
	let errors = $state<Partial<Record<FieldKey, string>>>({});
	let saveError = $state<string | null>(null);
	let saving = $state(false);

	interface LearnedContext {
		limit: number;
		largestFit: number;
		learnedAt: number;
		expiresAt: number;
	}
	/** What overflow errors taught the server about this model's real context, if anything. */
	let learned = $state<LearnedContext | null>(null);
	let reported = $state<number | null>(null);
	let forgetting = $state(false);

	async function loadLearned(id: string) {
		try {
			const res = await fetch(`/api/models/${id}/context`);
			if (!res.ok || model?.id !== id) return;
			const body = (await res.json()) as {
				reported: number | null;
				learned: LearnedContext | null;
			};
			reported = body.reported;
			learned = body.learned;
		} catch {
			// informational only
		}
	}

	async function forgetLearned() {
		if (!model) return;
		forgetting = true;
		try {
			const res = await fetch(`/api/models/${model.id}/context`, { method: 'DELETE' });
			if (!res.ok) throw new Error(`Request failed (${res.status})`);
			learned = null;
			toast.success('Learned context limit forgotten');
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not forget the limit');
		} finally {
			forgetting = false;
		}
	}

	function emptyValues(): Record<FieldKey, string> {
		return {
			priceInput: '',
			priceOutput: '',
			priceCacheRead: '',
			priceCacheWrite: '',
			contextLength: ''
		};
	}

	/** Prices as money: "0.80", "15.00", but "0.0375" keeps its digits. Also drops float
	 *  noise from the API (0.7999999999999999 → 0.80). */
	function priceText(value: number | null): string {
		if (value === null) return '';
		const clean = Number(value.toPrecision(10));
		return Number(clean.toFixed(2)) === clean ? clean.toFixed(2) : String(clean);
	}

	function formatPrice(key: PriceKey) {
		const result = parse(key, values[key]);
		if ('value' in result && result.value !== null) values[key] = priceText(result.value);
	}

	const snapshot = () => JSON.stringify({ caps: [...caps].sort(), values });

	// Load the model's values each time the dialog opens on one.
	$effect(() => {
		if (!model) return;
		caps = model.capabilities.filter(isEditableCapability);
		values = {
			priceInput: priceText(model.priceInput),
			priceOutput: priceText(model.priceOutput),
			priceCacheRead: priceText(model.priceCacheRead),
			priceCacheWrite: priceText(model.priceCacheWrite),
			contextLength: model.contextLength === null ? '' : model.contextLength.toLocaleString('en-US')
		};
		errors = {};
		saveError = null;
		learned = null;
		reported = null;
		void loadLearned(model.id);
		// untrack: reading the form here must not make edits re-run this load.
		initial = untrack(snapshot);
	});

	const dirty = $derived(model !== null && snapshot() !== initial);
	const chatOn = $derived(caps.includes('chat'));

	function toggle(cap: EditableCapability, on: boolean) {
		caps = on ? [...caps, cap] : caps.filter((c) => c !== cap);
	}

	/** Parses one field; returns the value or an error message. Empty means unknown. */
	function parse(key: FieldKey, raw: string): { value: number | null } | { error: string } {
		if (key === 'contextLength') {
			const trimmed = raw.trim().replace(/[\s_,.']/g, '');
			if (trimmed === '') return { value: null };
			const value = Number(trimmed);
			return Number.isInteger(value) && value > 0
				? { value }
				: { error: 'Enter a whole number of tokens' };
		}
		const trimmed = raw.trim().replace(',', '.');
		if (trimmed === '') return { value: null };
		const value = Number(trimmed);
		return Number.isFinite(value) && value >= 0 ? { value } : { error: 'Enter a price like 0.80' };
	}

	function validate(key: FieldKey) {
		const result = parse(key, values[key]);
		errors = { ...errors, [key]: 'error' in result ? result.error : undefined };
	}

	/** What a typical chat turn would cost at these prices, as a sanity check while typing. */
	const EXAMPLE = { input: 10_000, output: 1_000 };
	const exampleCost = $derived.by(() => {
		const input = parse('priceInput', values.priceInput);
		const output = parse('priceOutput', values.priceOutput);
		if (
			!('value' in input) ||
			!('value' in output) ||
			input.value === null ||
			output.value === null
		)
			return null;
		const usd = (input.value * EXAMPLE.input + output.value * EXAMPLE.output) / 1_000_000;
		return usd === 0 ? 'Free' : usd < 0.0001 ? '< $0.0001' : `$${Number(usd.toPrecision(2))}`;
	});

	/** Shows the context window with separators once the field is left ("32,768"). */
	function formatContext() {
		const result = parse('contextLength', values.contextLength);
		if ('value' in result && result.value)
			values.contextLength = result.value.toLocaleString('en-US');
	}

	const errorCount = $derived(Object.values(errors).filter(Boolean).length);

	const contextHint = $derived.by(() => {
		const result = parse('contextLength', values.contextLength);
		return 'value' in result && result.value && result.value >= 1_000_000
			? `${formatCount(result.value)} tokens`
			: null;
	});

	async function save(event: SubmitEvent) {
		event.preventDefault();
		if (!model) return;
		const keys = [...PRICE_FIELDS.map((f) => f.key), 'contextLength'] as FieldKey[];
		const parsed = Object.fromEntries(keys.map((k) => [k, parse(k, values[k])]));
		errors = Object.fromEntries(
			keys.map((k) => [k, 'error' in parsed[k] ? parsed[k].error : undefined])
		);
		const firstBad = keys.find((k) => errors[k]);
		if (firstBad) {
			tab = 'pricing';
			await tick();
			document.getElementById(`model-${firstBad}`)?.focus();
			return;
		}
		const numbers = Object.fromEntries(
			keys.map((k) => [k, (parsed[k] as { value: number | null }).value])
		);
		saving = true;
		saveError = null;
		try {
			const res = await fetch(`/api/models/${model.id}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					// Keep capabilities this dialog doesn't list (e.g. synced input kinds).
					capabilities: [...caps, ...model.capabilities.filter((c) => !isEditableCapability(c))],
					...numbers
				})
			});
			if (!res.ok) {
				const payload = (await res.json().catch(() => null)) as { message?: string } | null;
				throw new Error(payload?.message ?? `Request failed (${res.status})`);
			}
			toast.success(`${name} updated`);
			onClose();
			await invalidateAll();
		} catch (e) {
			saveError = e instanceof Error ? e.message : 'Could not save the model';
		} finally {
			saving = false;
		}
	}
</script>

{#snippet fieldError(key: FieldKey)}
	{#if errors[key]}
		<p id="model-{key}-error" class="flex items-center gap-1 text-xs text-destructive">
			<CircleAlertIcon class="size-3 shrink-0" />{errors[key]}
		</p>
	{/if}
{/snippet}

<Dialog.Root open={model !== null} onOpenChange={(open) => !open && onClose()}>
	<Dialog.Content class="gap-5 sm:max-w-lg">
		<Dialog.Header class="flex-row items-center gap-3 pr-8 text-left">
			<div
				class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground"
			>
				{@render icon()}
			</div>
			<div class="flex min-w-0 flex-col gap-0.5">
				<Dialog.Title class="truncate">{name}</Dialog.Title>
				<Dialog.Description class="truncate font-mono text-xs" title={model?.modelId}>
					{model?.modelId}{#if maker && !model?.modelId.includes('/')}
						· {maker}{/if}
				</Dialog.Description>
			</div>
		</Dialog.Header>

		<form id="model-edit-form" onsubmit={save} novalidate>
			<Tabs.Root bind:value={tab} class="gap-4">
				<Tabs.List class="w-full">
					<Tabs.Trigger value="capabilities" class="flex-1 data-[state=inactive]:text-foreground/70"
						>Capabilities</Tabs.Trigger
					>
					<Tabs.Trigger value="pricing" class="flex-1 data-[state=inactive]:text-foreground/70">
						Pricing &amp; context
						{#if Object.values(errors).some(Boolean)}<CircleAlertIcon
								class="size-3.5 text-destructive"
								aria-label="has errors"
							/>{/if}
					</Tabs.Trigger>
				</Tabs.List>

				<!-- Both panels share a minimum height, so switching tabs doesn't resize the dialog. -->
				<Tabs.Content value="capabilities" class="flex flex-col gap-4 sm:min-h-[27rem]">
					{#each CAPABILITY_GROUPS as group (group.title)}
						<fieldset class="flex flex-col gap-0.5">
							<legend
								class="mb-1.5 px-2 text-[11px] font-semibold tracking-wider text-foreground/60 uppercase"
								>{group.title}</legend
							>
							{#each group.items as cap (cap.id)}
								{@const disabled = NEEDS_CHAT.has(cap.id) && !chatOn}
								<label
									class="flex items-center gap-3 rounded-lg px-2 py-2 {disabled
										? 'opacity-50'
										: 'cursor-pointer hover:bg-accent/40'}"
								>
									<cap.icon class="size-4 shrink-0 text-muted-foreground" />
									<span class="flex min-w-0 flex-1 flex-col">
										<span class="text-sm font-medium">{cap.label}</span>
										<span class="text-xs text-muted-foreground"
											>{disabled ? 'Needs Chat.' : cap.description}</span
										>
									</span>
									<Switch
										checked={caps.includes(cap.id)}
										{disabled}
										class="data-unchecked:border-foreground/15"
										onCheckedChange={(on) => toggle(cap.id, on)}
									/>
								</label>
							{/each}
						</fieldset>
					{/each}
				</Tabs.Content>

				<Tabs.Content value="pricing" class="flex flex-col gap-5 sm:min-h-[27rem]">
					<fieldset class="flex flex-col gap-3">
						<legend
							class="mb-3 text-[11px] font-semibold tracking-wider text-foreground/60 uppercase"
						>
							Price · USD per 1M tokens
						</legend>
						<div class="grid grid-cols-2 gap-x-3 gap-y-4">
							{#each PRICE_FIELDS as field (field.key)}
								{@const id = `model-${field.key}`}
								<div class="flex flex-col gap-1.5">
									<Label for={id}>{field.label}</Label>
									<div class="relative">
										<span
											class="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-muted-foreground"
											aria-hidden="true">$</span
										>
										<Input
											{id}
											bind:value={values[field.key]}
											onblur={() => {
												validate(field.key);
												formatPrice(field.key);
											}}
											oninput={() => errors[field.key] && validate(field.key)}
											inputmode="decimal"
											autocomplete="off"
											placeholder={field.placeholder}
											aria-invalid={errors[field.key] ? 'true' : undefined}
											aria-describedby={errors[field.key] ? `${id}-error` : undefined}
											class="pl-7 tabular-nums"
										/>
									</div>
									{@render fieldError(field.key)}
								</div>
							{/each}
						</div>
						<p class="-mt-1 text-xs text-muted-foreground">
							Cache prices are optional; empty uses the input price.
						</p>
						<div
							class="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/50 px-3 py-2 text-sm"
							aria-live="polite"
						>
							<span class="text-muted-foreground">
								A chat turn with {formatCount(EXAMPLE.input)} tokens in and {formatCount(
									EXAMPLE.output
								)}
								out
							</span>
							<span
								class="shrink-0 font-medium tabular-nums {exampleCost
									? ''
									: 'text-xs font-normal text-muted-foreground'}"
								>{exampleCost ?? 'Add prices to see cost'}</span
							>
						</div>
					</fieldset>

					<div class="flex flex-col gap-1.5">
						<div class="flex items-baseline justify-between gap-2">
							<Label for="model-contextLength">Context window</Label>
							{#if contextHint}<span class="text-xs text-muted-foreground tabular-nums"
									>{contextHint}</span
								>{/if}
						</div>
						<div class="relative">
							<Input
								id="model-contextLength"
								bind:value={values.contextLength}
								onblur={() => {
									validate('contextLength');
									formatContext();
								}}
								oninput={() => errors.contextLength && validate('contextLength')}
								inputmode="numeric"
								autocomplete="off"
								placeholder="e.g. 200000"
								aria-invalid={errors.contextLength ? 'true' : undefined}
								aria-describedby={errors.contextLength ? 'model-contextLength-error' : undefined}
								class="pr-16 tabular-nums"
							/>
							<span
								class="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-xs text-muted-foreground"
								aria-hidden="true">tokens</span
							>
						</div>
						{@render fieldError('contextLength')}
						<p class="text-xs text-muted-foreground">
							Used to compact long chats automatically. Synced from providers that report it.
						</p>
						{#if learned}
							<div
								class="mt-1 flex items-start gap-3 rounded-lg border border-border/60 bg-muted/50 px-3 py-2 text-sm"
								aria-live="polite"
							>
								<div class="flex min-w-0 flex-1 flex-col gap-0.5">
									<span>
										Learned limit:
										<span class="font-medium tabular-nums"
											>{learned.limit.toLocaleString('en-US')} tokens</span
										>
									</span>
									<span class="text-xs text-muted-foreground">
										The model rejected a longer prompt {formatAge(Date.now() - learned.learnedAt)} ago{reported
											? ` (it reports ${reported.toLocaleString('en-US')})`
											: ''}, so prompts are kept below this. {learned.largestFit > 0
											? `Largest request that fit since: ${learned.largestFit.toLocaleString('en-US')}. `
											: ''}Forgotten after a day or when the reported context changes.
									</span>
								</div>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									class="shrink-0"
									disabled={forgetting}
									onclick={forgetLearned}>Forget</Button
								>
							</div>
						{/if}
					</div>
				</Tabs.Content>
			</Tabs.Root>
		</form>

		<!-- Screen readers hear about errors even when they're on the other tab. -->
		<p class="sr-only" aria-live="assertive">
			{errorCount > 0
				? `${errorCount} field${errorCount === 1 ? '' : 's'} on Pricing need fixing`
				: ''}
		</p>

		<Dialog.Footer class="items-center">
			{#if saveError}
				<p role="alert" class="flex items-center gap-1.5 text-sm text-destructive sm:mr-auto">
					<CircleAlertIcon class="size-4 shrink-0" />{saveError}
				</p>
			{/if}
			<Button variant="outline" class="max-sm:w-full" onclick={onClose}>Cancel</Button>
			<Button
				type="submit"
				form="model-edit-form"
				class="max-sm:w-full"
				disabled={saving || !dirty}
				title={dirty ? undefined : 'No changes yet'}
			>
				{saving ? 'Saving…' : 'Save changes'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
