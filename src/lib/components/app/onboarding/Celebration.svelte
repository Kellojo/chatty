<script lang="ts">
	/** A one-off burst of confetti from the centre of its (relative) parent. Decorative. */
	const COLORS = [
		'var(--chart-1)',
		'var(--chart-2)',
		'var(--chart-3)',
		'var(--chart-4)',
		'var(--chart-5)'
	];
	const pieces = Array.from({ length: 28 }, (_, i) => {
		const angle = (i / 28) * Math.PI * 2 + (i % 3) * 0.2;
		const distance = 70 + ((i * 37) % 60);
		return {
			x: Math.cos(angle) * distance,
			y: Math.sin(angle) * distance - 20,
			rotate: (i * 47) % 360,
			color: COLORS[i % COLORS.length],
			round: i % 3 === 0,
			delay: (i % 5) * 0.02
		};
	});
</script>

<span class="pointer-events-none absolute inset-0" aria-hidden="true">
	{#each pieces as piece, i (i)}
		<span
			class="piece absolute top-1/2 left-1/2"
			class:round={piece.round}
			style="--x: {piece.x}px; --y: {piece.y}px; --r: {piece.rotate}deg; --c: {piece.color}; animation-delay: {piece.delay}s"
		></span>
	{/each}
	<span class="burst-ring absolute inset-0 rounded-full"></span>
</span>

<style>
	.piece {
		width: 7px;
		height: 3px;
		margin: -1.5px 0 0 -3.5px;
		background: var(--c);
		border-radius: 1px;
		opacity: 0;
		animation: burst 1.1s cubic-bezier(0.15, 0.7, 0.3, 1) 0.15s both;
	}
	.round {
		width: 5px;
		height: 5px;
		border-radius: 50%;
	}
	@keyframes burst {
		0% {
			opacity: 1;
			transform: translate(0, 0) rotate(0) scale(0.4);
		}
		70% {
			opacity: 1;
		}
		100% {
			opacity: 0;
			transform: translate(var(--x), calc(var(--y) + 30px)) rotate(var(--r)) scale(1);
		}
	}
	.burst-ring {
		border: 2px solid var(--foreground);
		opacity: 0;
		animation: ring 0.8s ease-out 0.1s both;
	}
	@keyframes ring {
		from {
			opacity: 0.4;
			transform: scale(1);
		}
		to {
			opacity: 0;
			transform: scale(2.2);
		}
	}
</style>
