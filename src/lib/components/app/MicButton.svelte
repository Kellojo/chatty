<script lang="ts">
	import { toast } from 'svelte-sonner';
	import MicIcon from '@lucide/svelte/icons/mic';
	import SquareIcon from '@lucide/svelte/icons/square';

	type SpeechState = {
		supported: boolean;
		recording: boolean;
		busy?: boolean;
		start: (options?: { onError?: (msg: string) => void }) => void;
		stop: () => void;
		readFrequencyData?: () => Uint8Array;
	};

	let { speech }: { speech: SpeechState } = $props();

	const recording = $derived(speech.recording);
	const transcribing = $derived(!speech.recording && (speech.busy ?? false));
	const active = $derived(recording || transcribing);
	let hover = $state(false);

	// Scrolling spectrogram: each tick appends a new bar from the right,
	// older bars slide left. We keep ~2s of history at 100ms ticks.
	const HISTORY = 7;
	const MIN_HEIGHT = 3;
	const MAX_HEIGHT = 26;
	let history = $state<number[]>(Array.from({ length: HISTORY }, () => MIN_HEIGHT));
	let waveTimer: ReturnType<typeof setInterval> | undefined;

	$effect(() => {
		if (!speech.recording || !speech.readFrequencyData) {
			if (waveTimer) clearInterval(waveTimer);
			history = Array.from({ length: HISTORY }, () => MIN_HEIGHT);
			return;
		}
		waveTimer = setInterval(() => {
			const data = speech.readFrequencyData!();
			if (data.length === 0) return;

			// Average energy across the voice spectrum for a single bar.
			const voiceBins = Math.floor(data.length * 0.6);
			let sum = 0;
			for (let j = 0; j < voiceBins; j++) sum += data[j] ?? 0;
			const avg = sum / voiceBins;
			const scaled = Math.pow(avg / 255, 0.25);
			const raw = MIN_HEIGHT + scaled * (MAX_HEIGHT - MIN_HEIGHT);
			const h = Math.max(MIN_HEIGHT, Math.round(raw));

			// Shift left, append new value on the right.
			history = [...history.slice(1), h];
		}, 100);
		return () => clearInterval(waveTimer);
	});
</script>

{#if speech.supported}
	<button
		type="button"
		class="relative inline-flex size-9 items-center justify-center rounded-md transition-colors hover:bg-accent hover:text-accent-foreground"
		class:recording={active}
		title={active ? 'Stop recording' : 'Dictate'}
		aria-label={active ? 'Stop recording' : 'Start voice input'}
		onmouseenter={() => (hover = true)}
		onmouseleave={() => (hover = false)}
		onclick={() => {
			if (active) speech.stop();
			else speech.start({ onError: (m) => toast.error(m) });
		}}
	>
		{#if transcribing}
			<!-- Small spinner while waiting for transcription -->
			<svg class="size-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
				<circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" opacity="0.25" />
				<path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" stroke-width="3" stroke-linecap="round" />
			</svg>
		{:else if recording && !hover}
			<!-- Scrolling spectrogram -->
			<svg viewBox="0 0 24 28" class="size-5" aria-hidden="true">
				{#each history as h, i}
					{@const barW = 6.5}
					{@const gap = 1.5}
					<rect
						x={i * (barW + gap)}
						y={28 - h}
						width={barW}
						height={h < MIN_HEIGHT ? MIN_HEIGHT : h}
						rx="0.5"
						fill="currentColor"
						opacity={0.3 + 0.7 * (i / (HISTORY - 1))}
					/>
				{/each}
			</svg>
		{:else if recording && hover}
			<SquareIcon class="size-4" />
		{:else}
			<MicIcon class="size-4" />
		{/if}
	</button>
{/if}

<style>
	.recording {
		color: rgb(30 30 30);
		dark {
			color: rgb(220 220 220);
		}
	}
</style>
