<script lang="ts">
	import LoaderIcon from '@lucide/svelte/icons/loader';
	import PlayIcon from '@lucide/svelte/icons/play';
	import SquareIcon from '@lucide/svelte/icons/square';
	import { Button } from '$lib/components/ui/button/index.js';
	import type { SpeechPlayback } from '$lib/state/speech-playback.svelte.js';

	/** Plays a sample sentence through `playback`, or stops it. */
	let {
		playback,
		text,
		voice,
		label = 'Preview',
		disabled = false
	}: {
		playback: SpeechPlayback;
		text: string;
		/** The voice to sample; unset uses the configured one. */
		voice?: string;
		label?: string;
		disabled?: boolean;
	} = $props();

	const PREVIEW_ID = 'settings-preview';
	const playing = $derived(playback.activeId === PREVIEW_ID);
</script>

<Button
	variant="outline"
	size="sm"
	disabled={disabled || !playback.supported}
	aria-label={playing ? `Stop ${label.toLowerCase()}` : label}
	aria-busy={playing && playback.loading}
	onclick={() => playback.toggle(PREVIEW_ID, text, voice)}
>
	{#if playing && playback.loading}
		<LoaderIcon class="size-3.5 animate-spin" />
	{:else if playing}
		<SquareIcon class="size-3.5" />
	{:else}
		<PlayIcon class="size-3.5" />
	{/if}
	{playing ? 'Stop' : label}
</Button>
