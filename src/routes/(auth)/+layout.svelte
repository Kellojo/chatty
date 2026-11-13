<script lang="ts">
	import type { Snippet } from 'svelte';
	import AuthShell from '$lib/components/app/auth/AuthShell.svelte';

	let { children }: { children: Snippet } = $props();
</script>

<AuthShell>{@render children()}</AuthShell>
