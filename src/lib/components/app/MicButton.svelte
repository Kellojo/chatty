<script lang="ts">
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button/index.js';
	import MicIcon from '@lucide/svelte/icons/mic';
	import SquareIcon from '@lucide/svelte/icons/square';

	type SpeechState = {
		supported: boolean;
		recording: boolean;
		start: (options?: { onError?: (msg: string) => void }) => void;
		stop: () => void;
	};

	let { speech }: { speech: SpeechState } = $props();
</script>

{#if speech.supported}
	<Button
		variant="ghost"
		size="icon"
		title={speech.recording ? 'Stop recording' : 'Dictate'}
		onclick={() => {
			if (speech.recording) speech.stop();
			else speech.start({ onError: (m) => toast.error(m) });
		}}
		aria-label={speech.recording ? 'Stop recording' : 'Start voice input'}
		class={speech.recording ? 'animate-pulse' : ''}
	>
		{#if speech.recording}
			<SquareIcon class="size-4" />
		{:else}
			<MicIcon class="size-4" />
		{/if}
	</Button>
{/if}
