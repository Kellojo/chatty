<script lang="ts">
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import ScreenShareIcon from '@lucide/svelte/icons/screen-share';
	import { Button } from '$lib/components/ui/button/index.js';
	import { canCaptureScreen, captureScreen } from '$lib/screen-capture.js';

	/** Attaches one frame of a screen, window or tab the user picks. Desktop browsers only. */
	let { onfile }: { onfile: (file: File) => void } = $props();

	// Feature-detected after mount so SSR and hydration agree.
	let supported = $state(false);
	let busy = $state(false);
	onMount(() => {
		// Phones and tablets either lack screen capture or can only share the whole device.
		supported = canCaptureScreen() && window.matchMedia('(pointer: fine)').matches;
	});

	async function capture() {
		if (busy) return;
		busy = true;
		try {
			const file = await captureScreen();
			if (file) onfile(file);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not capture the screen');
		} finally {
			busy = false;
		}
	}
</script>

{#if supported}
	<Button
		variant="ghost"
		size="icon"
		aria-label="Attach a screenshot"
		title="Attach a screenshot"
		disabled={busy}
		onclick={capture}
	>
		<ScreenShareIcon class="size-4" />
	</Button>
{/if}
