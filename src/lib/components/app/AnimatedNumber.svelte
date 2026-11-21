<script lang="ts" module>
	/**
	 * How a number is shown, matching the string helpers in `$lib/formats`:
	 * - `integer`: 1,234
	 * - `count`: compact like `formatCount` (843, 1.5k, 2.5M)
	 * - `usd`: like `formatSpend` ($0, <$0.01, $1,234.56)
	 * - `percent`: a 0–1 fraction as a whole percent (42%)
	 * - `decimal`: up to one decimal (1.5)
	 */
	export type NumberFormatKind = 'integer' | 'count' | 'usd' | 'percent' | 'decimal';
</script>

<script lang="ts">
	import NumberFlow from '@number-flow/svelte';
	import { onMount } from 'svelte';
	import { countParts, formatSpend } from '$lib/formats.js';

	let {
		value,
		format = 'integer',
		prefix = '',
		suffix = '',
		fallback = '—',
		class: className
	}: {
		/** Strings render verbatim (e.g. "Not priced"); `null` renders `fallback`, both without prefix/suffix. */
		value: number | string | null | undefined;
		format?: NumberFormatKind;
		prefix?: string;
		suffix?: string;
		fallback?: string;
		class?: string;
	} = $props();

	const INTL: Record<Exclude<NumberFormatKind, 'count'>, Intl.NumberFormatOptions> = {
		integer: { maximumFractionDigits: 0 },
		decimal: { maximumFractionDigits: 1 },
		percent: { style: 'percent', maximumFractionDigits: 0 },
		usd: {
			style: 'currency',
			currency: 'USD',
			minimumFractionDigits: 2,
			maximumFractionDigits: 2
		}
	};

	/**
	 * NumberFlow's element rewrites its own server-rendered children when it
	 * upgrades, so they can't be hydrated (Svelte would remount the whole page):
	 * the server and hydration render the formatted text, NumberFlow takes over after.
	 */
	let mounted = $state(false);
	onMount(() => (mounted = true));

	/** What NumberFlow animates, or the text to show as-is. */
	const shown = $derived.by(
		(): { text: string } | { value: number; options: Intl.NumberFormatOptions; unit: string } => {
			if (typeof value === 'string') return { text: value };
			if (value == null || !Number.isFinite(value)) return { text: fallback };
			if (format === 'count') {
				const parts = countParts(value);
				return { value: parts.value, options: INTL.decimal, unit: parts.suffix };
			}
			if (format === 'usd') {
				// "<$0.01" can't be expressed as a number format.
				if (value !== 0 && Math.abs(value) < 0.01)
					return { text: `${prefix}${formatSpend(value)}${suffix}` };
				// Zero reads "$0", like formatSpend, not "$0.00".
				if (value === 0)
					return { value, options: { ...INTL.usd, minimumFractionDigits: 0 }, unit: '' };
			}
			return { value, options: INTL[format], unit: '' };
		}
	);
</script>

<!-- The wrapper takes layout classes (width, alignment), which the custom element ignores. -->
<span class={className}>
	{#if 'text' in shown}{shown.text}{:else if !mounted}{prefix}{new Intl.NumberFormat(
			'en-US',
			shown.options
		).format(shown.value)}{shown.unit}{suffix}{:else}<NumberFlow
			value={shown.value}
			format={shown.options}
			locales="en-US"
			{prefix}
			suffix={`${shown.unit}${suffix}`}
		/>{/if}
</span>
