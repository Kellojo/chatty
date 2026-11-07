<script lang="ts">
	import { Badge } from '$lib/components/ui/badge/index.js';
	import type { CodingEnvironment } from '$lib/coding-environments.js';

	let { environment }: { environment: CodingEnvironment } = $props();
</script>

{#if !environment.enabled}
	<Badge variant="outline">Disabled</Badge>
{:else if environment.status === 'online'}
	<Badge variant="secondary" class="gap-1.5">
		<span class="size-1.5 rounded-full bg-emerald-500"></span>
		Online
	</Badge>
{:else if environment.status === 'error'}
	<Badge variant="destructive" title={environment.lastError ?? undefined}>Unreachable</Badge>
{:else}
	<Badge variant="outline">Not checked</Badge>
{/if}
