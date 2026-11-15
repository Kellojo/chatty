<script lang="ts">
	import AudioLinesIcon from '@lucide/svelte/icons/audio-lines';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button/index.js';

	let {
		disabled = false,
		blockedReason,
		onclick
	}: {
		disabled?: boolean;
		/**
		 * Shown but not usable yet, with why as the tooltip (e.g. while dictating).
		 * Unlike `disabled` it keeps the tooltip, which a disabled button can't show.
		 */
		blockedReason?: string;
		onclick: () => void;
	} = $props();
</script>

<!--
	Voice mode sits where Send would be while the composer is empty, labelled so
	it doesn't read as a second dictation mic: the mic types what you say, this
	starts a spoken conversation.
-->
<Button
	size="sm"
	variant={blockedReason ? 'outline' : 'default'}
	class={['gap-1.5 pr-3.5 pl-3', blockedReason && 'cursor-default text-foreground/80']}
	{disabled}
	aria-disabled={blockedReason ? true : undefined}
	aria-label="Start voice mode"
	title={blockedReason ?? 'Voice mode: talk hands-free'}
	onclick={() => {
		// Touch has no tooltip, so a tap says why instead.
		if (blockedReason) toast.info(blockedReason);
		else onclick();
	}}
>
	<AudioLinesIcon class="size-4" />
	<span>Voice</span>
</Button>
