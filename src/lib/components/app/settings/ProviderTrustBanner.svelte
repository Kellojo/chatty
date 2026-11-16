<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import { Button } from '$lib/components/ui/button/index.js';
	import ProviderIcon from '$lib/components/app/ProviderIcon.svelte';
	import { resolveProviderBrand } from '$lib/provider-brand.js';

	/**
	 * A one-time question for local servers (LM Studio, Ollama) that were added
	 * before providers could be trusted with private data: nothing is trusted
	 * after an upgrade, so they'd otherwise sit unused for private chats.
	 * Answered either way, it doesn't come back (a dismissal is kept in this
	 * browser).
	 */
	let {
		providers
	}: {
		providers: {
			id: string;
			name: string;
			type: string;
			baseUrl: string | null;
			allowPrivate: boolean;
		}[];
	} = $props();

	const DISMISSED_KEY = 'chatty.providers.trustBannerDismissed';
	const LOCAL_BRANDS = new Set(['lmstudio', 'ollama']);

	let dismissed = $state<string[]>([]);
	let busy = $state<string | null>(null);

	onMount(() => {
		try {
			const stored = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]') as unknown;
			if (Array.isArray(stored)) dismissed = stored.filter((v) => typeof v === 'string');
		} catch {
			// storage unavailable or unreadable: ask again
		}
	});

	const asking = $derived(
		providers.flatMap((p) => {
			const brand = resolveProviderBrand(p);
			return brand && LOCAL_BRANDS.has(brand) && !p.allowPrivate && !dismissed.includes(p.id)
				? [{ ...p, brand }]
				: [];
		})
	);

	function dismiss(id: string) {
		dismissed = [...dismissed, id];
		try {
			localStorage.setItem(DISMISSED_KEY, JSON.stringify(dismissed));
		} catch {
			// storage unavailable: it's only hidden until the page reloads
		}
	}

	async function allow(id: string, name: string) {
		busy = id;
		try {
			const res = await fetch(`/api/providers/${id}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ allowPrivate: true })
			}).catch(() => null);
			if (!res?.ok) {
				const data = (await res?.json().catch(() => null)) as { message?: string } | null;
				toast.error(data?.message ?? `Couldn't update ${name}`);
				return;
			}
			toast.success(`${name} can now process private data`);
			await invalidateAll();
		} finally {
			busy = null;
		}
	}
</script>

{#each asking as provider (provider.id)}
	<div
		class="mb-4 flex flex-col gap-3 rounded-xl border bg-card p-4 text-sm sm:flex-row sm:items-center"
		role="region"
		aria-label="Allow {provider.name} to process private data"
	>
		<div class="flex min-w-0 flex-1 items-start gap-3">
			<ProviderIcon brand={provider.brand} class="mt-0.5 size-5 shrink-0" decorative />
			<div class="flex min-w-0 flex-col gap-0.5">
				<p class="font-medium">Allow {provider.name} to process private data?</p>
				<p class="text-muted-foreground">
					It looks like a local server. Private chats, notes and documents only reach providers you
					trust; if it forwards requests to a cloud service, that service sees them too.
				</p>
			</div>
		</div>
		<div class="flex shrink-0 gap-2 max-sm:justify-end">
			<Button
				variant="ghost"
				size="sm"
				disabled={busy === provider.id}
				onclick={() => dismiss(provider.id)}>Dismiss</Button
			>
			<Button
				size="sm"
				disabled={busy === provider.id}
				onclick={() => allow(provider.id, provider.name)}
			>
				<ShieldCheckIcon class="size-4" />
				Allow
			</Button>
		</div>
	</div>
{/each}
