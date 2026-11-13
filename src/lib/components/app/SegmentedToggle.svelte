<script lang="ts" generics="T extends string">
	// A compact row of mutually exclusive options, e.g. a chart's period or metric.
	let {
		options,
		value,
		onChange,
		label
	}: {
		options: readonly { value: T; label: string }[];
		value: T;
		onChange: (value: T) => void;
		/** Names the group for assistive tech. */
		label: string;
	} = $props();
</script>

<div class="flex rounded-lg border p-0.5" role="group" aria-label={label}>
	{#each options as option (option.value)}
		<button
			type="button"
			class="rounded-md px-2.5 py-1 text-xs {value === option.value
				? 'bg-accent font-medium text-accent-foreground'
				: 'text-muted-foreground hover:text-foreground'}"
			aria-pressed={value === option.value}
			onclick={() => onChange(option.value)}
		>
			{option.label}
		</button>
	{/each}
</div>
