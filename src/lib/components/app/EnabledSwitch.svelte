<script lang="ts">
	import { Switch } from '$lib/components/ui/switch/index.js';

	let {
		checked,
		label,
		disabled = false,
		onchange
	}: {
		checked: boolean;
		/** Accessible name, e.g. "Enable Meeting notes". */
		label: string;
		disabled?: boolean;
		onchange: (enabled: boolean) => void;
	} = $props();
</script>

<!-- Page-header on/off pill for an agent or skill; the change applies immediately. -->
<label
	class="flex h-9 items-center gap-2 rounded-full border px-3 text-sm text-muted-foreground has-[button:focus-visible]:ring-3 has-[button:focus-visible]:ring-ring/30"
>
	{checked ? 'Enabled' : 'Disabled'}
	<Switch {checked} {disabled} aria-label={label} onCheckedChange={onchange} />
</label>
