<script lang="ts">
	import { toast } from 'svelte-sonner';
	import MicIcon from '@lucide/svelte/icons/mic';

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

	// Live level meter: five bars, each driven by its own slice of the voice
	// band. Low frequencies sit in the middle so the shape reads as a
	// symmetric "voice" envelope rather than an EQ.
	const BARS = 5;
	const BAND_ORDER = [3, 1, 0, 2, 4];
	const FLOOR = 0.18;
	/** Relative peak of each bar in the placeholder wave (centre tallest). */
	const PEAKS = [0.6, 0.85, 1, 0.85, 0.6];
	// Time constants (ms) for the exponential smoothing: snappy rise, gentle fall.
	const ATTACK_MS = 25;
	const RELEASE_MS = 140;
	/** How long an all-zero analyser must stay silent before we trust it over the placeholder. */
	const SILENCE_MS = 400;

	const bars: HTMLSpanElement[] = [];
	/** True once the analyser delivered real samples; otherwise we animate a placeholder. */
	let live = $state(false);
	let elapsed = $state(0);

	$effect(() => {
		if (!recording) {
			live = false;
			elapsed = 0;
			return;
		}

		const startedAt = performance.now();
		let last = startedAt;
		const current: number[] = Array(BARS).fill(FLOOR);
		let frame = 0;
		let silentFor = 0;

		// Bars are written straight to the DOM so the meter doesn't re-render
		// the component 60+ times a second.
		const tick = (now: number) => {
			const dt = Math.min(100, now - last);
			last = now;
			const secs = Math.floor((now - startedAt) / 1000);
			if (secs !== elapsed) elapsed = secs;

			const data = speech.readFrequencyData?.();
			const targets: number[] = Array(BARS).fill(FLOOR);
			if (data && data.length > 0) {
				// ~0–4 kHz of a 128-bin analyser at 48 kHz covers the speech range.
				const voiceBins = Math.max(BARS, Math.floor(data.length * 0.35));
				const per = voiceBins / BARS;
				let any = false;
				for (let b = 0; b < BARS; b++) {
					let sum = 0;
					const from = Math.floor(b * per) + 1;
					const to = Math.floor((b + 1) * per) + 1;
					for (let j = from; j < to; j++) sum += data[j] ?? 0;
					const avg = sum / Math.max(1, to - from) / 255;
					if (avg > 0) any = true;
					targets[BAND_ORDER[b]] = FLOOR + (1 - FLOOR) * Math.min(1, Math.pow(avg, 0.7) * 1.35);
				}
				// A working analyser that stays fully silent (muted mic) is still
				// real data: switch to the meter so the bars rest flat instead of faking speech.
				silentFor = any ? 0 : silentFor + dt;
				if (!live && (any || silentFor > SILENCE_MS)) live = true;
			}
			// With no samples this frame, targets stay at FLOOR so the bars settle instead of freezing.
			if (live) {
				for (let i = 0; i < BARS; i++) {
					const tau = targets[i] > current[i] ? ATTACK_MS : RELEASE_MS;
					current[i] += (targets[i] - current[i]) * (1 - Math.exp(-dt / tau));
					bars[i]?.style.setProperty('transform', `scaleY(${current[i].toFixed(3)})`);
				}
			}
			frame = requestAnimationFrame(tick);
		};
		frame = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frame);
	});

	const timer = $derived(`${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`);
</script>

{#if speech.supported}
	<button
		type="button"
		class={[
			'mic group relative inline-flex h-9 items-center justify-center overflow-hidden rounded-full whitespace-nowrap transition-[background-color,color,width,padding] duration-200 ease-out outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
			recording &&
				'w-auto gap-2 bg-destructive/10 pr-3 pl-2.5 text-red-700 hover:bg-destructive/15 focus-visible:ring-destructive/30 dark:text-destructive',
			transcribing && 'w-auto cursor-default gap-2 bg-muted pr-3 pl-2.5 text-muted-foreground',
			!active && 'w-9 hover:bg-accent hover:text-accent-foreground'
		]}
		title={recording ? 'Stop recording' : transcribing ? undefined : 'Dictate'}
		aria-label={recording ? 'Stop recording' : transcribing ? 'Transcribing…' : 'Dictate'}
		aria-disabled={transcribing || undefined}
		onclick={() => {
			if (transcribing) return;
			if (recording) speech.stop();
			else speech.start({ onError: (m) => toast.error(m) });
		}}
	>
		{#if recording}
			<!-- Leading indicator: a pulsing record dot that turns into a stop square on hover/focus/touch. -->
			<span class="relative grid size-3.5 place-items-center" aria-hidden="true">
				<span class="dot grid"
					><span class="rec-dot block size-2 rounded-full bg-current"></span></span
				>
				<span class="stop absolute size-2.5 rounded-[2px] bg-current opacity-0"></span>
			</span>
			<span class="wave flex h-4 items-center gap-[3px]" class:idle={!live} aria-hidden="true">
				{#each PEAKS as peak, i (i)}
					<span bind:this={bars[i]} class="bar" style:--d={Math.abs(i - 2)} style:--peak={peak}
					></span>
				{/each}
			</span>
			<span class="min-w-[4ch] text-xs font-medium tabular-nums" aria-hidden="true">{timer}</span>
		{:else if transcribing}
			<svg
				class="size-3.5 motion-safe:animate-spin"
				viewBox="0 0 24 24"
				fill="none"
				aria-hidden="true"
			>
				<circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" opacity="0.25" />
				<path
					class="motion-reduce:hidden"
					d="M12 2a10 10 0 0 1 10 10"
					stroke="currentColor"
					stroke-width="3"
					stroke-linecap="round"
				/>
			</svg>
			<span class="text-xs font-medium" aria-hidden="true">Transcribing…</span>
		{:else}
			<MicIcon class="size-4" />
		{/if}
	</button>
	<!-- Always mounted so state changes are announced; live regions inside a labelled button are not. -->
	<span class="sr-only" role="status" aria-live="polite">
		{recording ? 'Recording' : transcribing ? 'Transcribing' : ''}
	</span>
{/if}

<style>
	/* Lets `width` animate between the fixed icon size and the pill's auto width. */
	@supports (interpolate-size: allow-keywords) {
		.mic {
			interpolate-size: allow-keywords;
		}
	}

	.bar {
		display: block;
		width: 3px;
		height: 16px;
		border-radius: 999px;
		background: currentColor;
		transform: scaleY(0.18); /* FLOOR; the meter writes inline transforms once live */
		transform-origin: center;
		will-change: transform;
	}

	/* No analyser data (mic shared with browser STT, or permissions): a calm
	   placeholder that pulses outward from the centre so it still reads as a voice. */
	.wave.idle .bar {
		animation: idle-wave 1.1s ease-in-out infinite;
		animation-delay: calc(var(--d) * -0.16s);
	}

	@keyframes idle-wave {
		0%,
		100% {
			transform: scaleY(0.18);
		}
		50% {
			transform: scaleY(calc(var(--peak) * 0.8));
		}
	}

	.rec-dot {
		animation: rec-pulse 1.6s ease-in-out infinite;
	}
	.dot,
	.stop {
		transition: opacity 150ms ease-out;
	}

	/* The pulse keeps running on the inner dot; only the wrapper fades, so
	   the swap back from the stop square doesn't restart the keyframes. */
	.mic:hover .dot,
	.mic:focus-visible .dot {
		opacity: 0;
	}
	.mic:hover .stop,
	.mic:focus-visible .stop {
		opacity: 1;
	}

	/* Touch has no hover: always show the stop affordance. */
	@media (pointer: coarse) {
		.dot {
			opacity: 0;
		}
		.stop {
			opacity: 1;
		}
	}

	@keyframes rec-pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.5;
			transform: scale(0.75);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.mic {
			transition: none;
		}
		.wave.idle .bar,
		.rec-dot {
			animation: none;
		}
		.wave.idle .bar {
			transform: scaleY(calc(var(--peak) * 0.5));
		}
	}
</style>
