<script lang="ts">
	import { onMount, type Snippet } from 'svelte';
	import AuthShell from '$lib/components/app/auth/AuthShell.svelte';
	import { clearUserDataCaches } from '$lib/offline-cache.js';

	let { children }: { children: Snippet } = $props();

	// Nobody is signed in here (an expired session lands here too), so no
	// account's offline chats should stay on the device.
	onMount(() => void clearUserDataCaches());
</script>

<AuthShell>{@render children()}</AuthShell>
