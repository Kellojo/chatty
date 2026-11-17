<script lang="ts">
	import { Label } from '$lib/components/ui/label/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import HouseIcon from '@lucide/svelte/icons/house';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';

	/**
	 * "Can process private data" for a provider form, with a hint whether its
	 * base URL looks local. The hint is advisory; only the admin sets the flag.
	 */
	let {
		id,
		checked = $bindable(false),
		type,
		baseUrl,
		name,
		wasAllowed = false
	}: {
		id: string;
		checked?: boolean;
		type: 'anthropic' | 'openai-compatible';
		baseUrl: string;
		name: string;
		/** Editing a provider that has the flag now: warn before it's turned off. */
		wasAllowed?: boolean;
	} = $props();

	const ANTHROPIC_URL = 'https://api.anthropic.com';
	const DEBOUNCE_MS = 400;

	const target = $derived(type === 'anthropic' ? baseUrl.trim() || ANTHROPIC_URL : baseUrl.trim());

	let locality = $state<{ url: string; looksLocal: boolean; host: string | null } | null>(null);

	$effect(() => {
		const url = target;
		const providerName = name.trim();
		if (!url) {
			locality = null;
			return;
		}
		const controller = new AbortController();
		const timer = setTimeout(async () => {
			try {
				const params = new URLSearchParams({ url, name: providerName });
				const res = await fetch(`/api/providers/locality?${params}`, {
					signal: controller.signal
				});
				if (!res.ok) return;
				const body = (await res.json()) as { looksLocal: boolean; host: string | null };
				locality = { url, ...body };
			} catch {
				// Aborted or offline: keep the last hint.
			}
		}, DEBOUNCE_MS);
		return () => {
			clearTimeout(timer);
			controller.abort();
		};
	});

	/** The hint, once it matches the URL being edited. */
	const current = $derived(locality?.url === target ? locality : null);
	const host = $derived.by(() => {
		if (current?.host) return current.host;
		try {
			return new URL(target).hostname;
		} catch {
			return null;
		}
	});
</script>

<div class="flex flex-col gap-2">
	<div class="flex items-start justify-between gap-4">
		<div class="flex flex-col gap-1">
			<Label for={id}>Can process private data</Label>
			<p class="text-xs text-pretty text-muted-foreground">
				Private chats, notes and agents may only use providers with this on. Turn it on only if you
				trust where this provider sends data.
			</p>
		</div>
		<Switch {id} bind:checked class="mt-0.5" />
	</div>
	{#if current?.looksLocal}
		<p class="flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400">
			<HouseIcon class="size-3.5 shrink-0" aria-hidden="true" />Looks local (localhost / LAN)
		</p>
	{/if}
	{#if checked && current && !current.looksLocal && host}
		<div
			class="flex items-start gap-2 rounded-xl bg-amber-500/10 px-3 py-2.5 text-sm text-amber-800 dark:text-amber-300"
		>
			<TriangleAlertIcon class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
			<p class="min-w-0 break-words">
				Private data will be sent to <span class="font-mono">{host}</span>, an external service.
			</p>
		</div>
	{/if}
	{#if wasAllowed && !checked}
		<div
			class="flex items-start gap-2 rounded-xl bg-amber-500/10 px-3 py-2.5 text-sm text-amber-800 dark:text-amber-300"
		>
			<TriangleAlertIcon class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
			<p>
				Private chats and agents using this provider will pause until they're switched to a trusted
				model.
			</p>
		</div>
	{/if}
</div>
