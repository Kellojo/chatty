<script lang="ts">
	import { Toaster as Sonner, toast, type ToasterProps as SonnerProps } from 'svelte-sonner';
	import { haptic } from '$lib/haptics.svelte.js';
	import { mode } from 'mode-watcher';
	import Loader2Icon from '@lucide/svelte/icons/loader-2';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import OctagonXIcon from '@lucide/svelte/icons/octagon-x';
	import InfoIcon from '@lucide/svelte/icons/info';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';

	let { ...restProps }: SonnerProps = $props();

	// Success, warning and error toasts come with a matching haptic on touch devices.
	// (`useSonner()` only works inside <Toaster>, which sets its context; getActiveToasts
	// reads the same reactive store, so the effect still re-runs on every new toast.)
	// Plain bookkeeping, deliberately not reactive: the effect below writes to it.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	const felt = new Set<string | number>();
	$effect(() => {
		for (const t of toast.getActiveToasts()) {
			if (felt.has(t.id)) continue;
			felt.add(t.id);
			if (t.type === 'success' || t.type === 'warning' || t.type === 'error') haptic(t.type);
		}
	});
</script>

<Sonner
	theme={mode.current}
	class="toaster group"
	style="--normal-bg: var(--color-popover); --normal-text: var(--color-popover-foreground); --normal-border: var(--color-border);"
	{...restProps}
>
	{#snippet loadingIcon()}
		<Loader2Icon class="size-4 animate-spin" />
	{/snippet}
	{#snippet successIcon()}
		<CircleCheckIcon class="size-4" />
	{/snippet}
	{#snippet errorIcon()}
		<OctagonXIcon class="size-4" />
	{/snippet}
	{#snippet infoIcon()}
		<InfoIcon class="size-4" />
	{/snippet}
	{#snippet warningIcon()}
		<TriangleAlertIcon class="size-4" />
	{/snippet}
</Sonner>
