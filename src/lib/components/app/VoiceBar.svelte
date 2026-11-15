<script lang="ts">
	import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
	import MicIcon from '@lucide/svelte/icons/mic';
	import MicOffIcon from '@lucide/svelte/icons/mic-off';
	import PhoneOffIcon from '@lucide/svelte/icons/phone-off';
	import SquareIcon from '@lucide/svelte/icons/square';
	import { onMount } from 'svelte';
	import type { VoiceMode, VoicePhase } from '$lib/state/voice-mode.svelte.js';

	let { voice }: { voice: VoiceMode } = $props();

	const LABELS: Record<VoicePhase, string> = {
		off: '',
		starting: 'Starting…',
		listening: 'Listening',
		hearing: 'Hearing you',
		transcribing: 'Got it…',
		thinking: 'Thinking…',
		speaking: 'Speaking'
	};

	/** Kept short: they share a narrow column with the controls on phones. */
	const HINTS: Record<VoicePhase, string> = {
		off: '',
		starting: 'Allow the mic if asked',
		listening: 'Talk, then pause or tap the orb',
		hearing: 'Pause or tap Send when done',
		transcribing: 'One moment',
		thinking: 'Working on it',
		speaking: 'Talk to interrupt'
	};

	const phase = $derived(voice.phase);
	/**
	 * One slot holds the action that matters now: Mute while waiting for the
	 * user, Send while they talk, Stop during the reply.
	 */
	const answering = $derived(phase === 'thinking' || phase === 'speaking');
	const talking = $derived(phase === 'hearing' && !voice.muted);
	/** Muting only matters while it's the user's turn; the reply carries on regardless. */
	const mutedTurn = $derived(voice.muted && (phase === 'listening' || phase === 'hearing'));
	const label = $derived(mutedTurn ? 'Muted' : LABELS[phase]);
	const hint = $derived(mutedTurn ? 'Unmute to keep talking' : HINTS[phase]);
	/**
	 * The user's words, only while they're current: live as they talk, then what
	 * was understood until the reply starts (the chat above keeps the rest).
	 */
	const caption = $derived(
		phase === 'hearing'
			? voice.interim
			: phase === 'transcribing' || phase === 'thinking'
				? voice.lastHeard
				: ''
	);
	const orbLabel = $derived(
		phase === 'speaking'
			? 'Interrupt the reply'
			: phase === 'thinking'
				? 'Cancel the reply'
				: phase === 'listening' || phase === 'hearing'
					? 'Done talking'
					: phase === 'transcribing'
						? 'Transcribing what you said'
						: 'Starting voice mode'
	);

	let orb: HTMLButtonElement | undefined = $state();
	/** Nothing to do on tap while the microphone opens or a turn is transcribed. */
	const orbIdle = $derived(phase === 'starting' || phase === 'transcribing');

	// The Voice button that started this unmounted with the composer: keep
	// keyboard focus in the bar instead of losing it to the page.
	onMount(() => {
		if (!document.activeElement || document.activeElement === document.body) orb?.focus();
	});

	// The orb swells with the microphone level while the user talks. Written
	// straight to the DOM so it doesn't re-render the component every frame.
	$effect(() => {
		if (!orb || (phase !== 'listening' && phase !== 'hearing') || voice.muted) {
			orb?.style.removeProperty('--level');
			return;
		}
		let current = 0;
		let frame = 0;
		const tick = () => {
			const target = Math.min(1, Math.sqrt(voice.readLevel()) * 3);
			current += (target - current) * (target > current ? 0.5 : 0.12);
			orb?.style.setProperty('--level', current.toFixed(3));
			frame = requestAnimationFrame(tick);
		};
		frame = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frame);
	});
</script>

{#snippet control(
	label: string,
	text: string,
	title: string,
	onclick: () => void,
	icon: typeof MicIcon,
	look: 'default' | 'pressed' | 'strong' | 'quiet' = 'default',
	/** A toggle button's state (fixed label, aria-pressed); unset for plain buttons. */
	toggled?: boolean,
	/** Shows its text on phones too, not just the icon. */
	labelled = false,
	keys?: string
)}
	{@const Icon = icon}
	<button
		type="button"
		class={[
			'inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-full text-sm font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
			labelled ? 'px-4' : 'max-sm:w-11 sm:px-4',
			{
				default: 'bg-muted text-foreground hover:bg-accent',
				// Muted is a calm amber, not dictation's recording red.
				pressed: 'bg-warning/15 text-warning-foreground hover:bg-warning/20 dark:text-warning',
				strong: 'bg-foreground text-background hover:bg-foreground/85',
				quiet: 'border text-foreground hover:bg-accent'
			}[look]
		]}
		aria-label={label}
		aria-pressed={toggled}
		aria-keyshortcuts={keys}
		{title}
		{onclick}
	>
		<Icon class={labelled ? 'size-4' : 'size-5 sm:size-4'} />
		<span class={labelled ? '' : 'max-sm:hidden'}>{text}</span>
	</button>
{/snippet}

<!-- The composer's height (empty), so the chat above doesn't jump when it swaps in. -->
<div
	class="voice-bar flex min-h-[114px] items-center gap-2 rounded-3xl border bg-card py-2.5 pr-2.5 pl-2.5 shadow-xs sm:gap-3 sm:pr-3 sm:pl-3"
	role="group"
	aria-label="Voice mode"
>
	<button
		bind:this={orb}
		type="button"
		class="orb-button relative grid size-14 shrink-0 cursor-pointer place-items-center rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-disabled:cursor-default sm:size-16"
		data-phase={phase}
		data-muted={voice.muted || undefined}
		aria-label={orbLabel}
		aria-disabled={orbIdle || undefined}
		onclick={() => {
			if (!orbIdle) voice.tap();
		}}
	>
		<span class="ring" aria-hidden="true"></span>
		<span class="ring ring-2" aria-hidden="true"></span>
		<span class="orb" aria-hidden="true"></span>
	</button>

	<div class="flex min-w-0 flex-1 flex-col gap-0.5 pr-1">
		<!-- One size in every phase; with the user's words below, the label steps back in colour only. -->
		<span
			class={['text-sm font-medium', caption && 'text-muted-foreground']}
			role="status"
			aria-live="polite"
			>{label}<!-- What was understood, announced once with the phase (live words change too often to read out). --><span
				class="sr-only"
				>{phase === 'thinking' && voice.lastHeard ? `. You said: ${voice.lastHeard}` : ''}</span
			></span
		>
		{#if caption}
			<p
				class={[
					'line-clamp-2 text-sm sm:text-base',
					phase === 'hearing' ? 'text-foreground' : 'text-foreground/80'
				]}
			>
				{caption}
			</p>
		{:else}
			<span class="line-clamp-2 text-[13px] leading-snug text-muted-foreground">{hint}</span>
		{/if}
	</div>

	{#if answering}
		{@render control(
			phase === 'speaking' ? 'Stop the reply' : 'Cancel the reply',
			'Stop',
			phase === 'speaking' ? 'Stop the reply and talk' : 'Cancel the reply',
			() => voice.tap(),
			SquareIcon,
			'strong',
			undefined,
			true
		)}
	{:else if talking}
		{@render control(
			'Send what you said',
			'Send',
			'Send now instead of waiting for a pause',
			() => voice.tap(),
			ArrowUpIcon,
			'strong',
			undefined,
			true
		)}
	{:else}
		{@render control(
			'Mute microphone',
			voice.muted ? 'Unmute' : 'Mute',
			voice.muted ? 'Unmute microphone' : 'Mute microphone',
			() => voice.setMuted(!voice.muted),
			voice.muted ? MicOffIcon : MicIcon,
			voice.muted ? 'pressed' : 'default',
			voice.muted
		)}
	{/if}
	{@render control(
		'End voice mode',
		'End',
		'End voice mode (Esc)',
		() => voice.stop(),
		// Hang up, not a second stop: Stop next to it ends only the reply.
		PhoneOffIcon,
		'quiet',
		undefined,
		false,
		'Escape'
	)}
</div>

<style>
	.voice-bar {
		animation: voice-in 160ms ease-out;
	}

	/*
	 * The Send/Stop pills carry the action; the orb is a shortcut for it, so its
	 * halo only appears on hover (at rest it would read as a second border).
	 */
	.orb-button {
		--level: 0;
		transition: box-shadow 150ms ease;
	}
	.orb-button:not([aria-disabled]):hover {
		box-shadow: 0 0 0 4px color-mix(in oklch, var(--info) 28%, transparent);
	}
	.orb-button:hover .orb {
		filter: brightness(1.08);
	}
	/* Muted is amber everywhere, outline included. */
	.orb-button[data-muted] {
		box-shadow: 0 0 0 4px color-mix(in oklch, var(--warning) 22%, transparent);
	}

	@keyframes voice-in {
		from {
			opacity: 0;
			transform: translateY(4px);
		}
	}

	.orb {
		position: absolute;
		inset: 7px;
		border-radius: 999px;
		background:
			radial-gradient(
				circle at 35% 30%,
				color-mix(in oklch, var(--info) 35%, white) 0%,
				transparent 55%
			),
			radial-gradient(
				circle at 70% 75%,
				color-mix(in oklch, var(--info) 70%, var(--primary)) 0%,
				transparent 70%
			),
			var(--info);
		box-shadow: 0 0 calc(8px + var(--level) * 28px)
			color-mix(in oklch, var(--info) 45%, transparent);
		transform: scale(calc(0.86 + var(--level) * 0.26));
		transition:
			transform 80ms linear,
			filter 300ms ease,
			opacity 300ms ease;
	}

	.ring {
		position: absolute;
		inset: 7px;
		border-radius: 999px;
		border: 2.5px solid color-mix(in oklch, var(--info) 55%, transparent);
		opacity: 0;
	}

	[data-phase='starting'] .orb,
	[data-phase='transcribing'] .orb,
	[data-muted] .orb {
		filter: saturate(0.25);
		opacity: 0.8;
	}

	[data-phase='thinking'] .orb {
		animation: breathe 1.8s ease-in-out infinite;
	}

	[data-phase='transcribing'] .orb,
	[data-phase='starting'] .orb {
		animation: breathe 1.1s ease-in-out infinite;
	}

	[data-phase='speaking'] .orb {
		animation: talk 0.9s ease-in-out infinite;
	}
	[data-phase='speaking'] .ring {
		animation: ripple 1.8s ease-out infinite;
	}
	[data-phase='speaking'] .ring-2 {
		animation-delay: 0.9s;
	}

	/* Waiting for the user: one ring glows slowly so the bar reads as live. */
	[data-phase='listening']:not([data-muted]) .ring:not(.ring-2) {
		animation: listen 2.8s ease-in-out infinite;
	}

	@keyframes listen {
		0%,
		100% {
			transform: scale(1.04);
			opacity: 0.15;
		}
		50% {
			transform: scale(1.12);
			opacity: 0.7;
		}
	}

	@keyframes breathe {
		0%,
		100% {
			transform: scale(0.82);
		}
		50% {
			transform: scale(0.94);
		}
	}

	@keyframes talk {
		0%,
		100% {
			transform: scale(0.88);
		}
		30% {
			transform: scale(1.08);
		}
		60% {
			transform: scale(0.94);
		}
	}

	@keyframes ripple {
		/* Starts at the orb's edge so a ring is visible from the first frame. */
		from {
			transform: scale(1);
			opacity: 0.65;
		}
		to {
			transform: scale(1.55);
			opacity: 0;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.voice-bar,
		.orb,
		.ring {
			animation: none !important;
			transition: none;
		}
		.orb {
			transform: none;
		}
	}
</style>
