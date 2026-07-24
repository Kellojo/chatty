<script lang="ts">
	import { resolve } from '$app/paths';
	import AgentEditor from '$lib/components/app/AgentEditor.svelte';
	import * as Breadcrumb from '$lib/components/ui/breadcrumb/index.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
	<div class="mx-auto flex w-full max-w-7xl flex-col gap-4 p-6">
		<div class="flex flex-col gap-1">
			<Breadcrumb.Root>
				<Breadcrumb.List>
					<Breadcrumb.Item>
						<Breadcrumb.Link href={resolve('/agents')}>Agents</Breadcrumb.Link>
					</Breadcrumb.Item>
					<Breadcrumb.Separator />
					<Breadcrumb.Item>
						<Breadcrumb.Page>New agent</Breadcrumb.Page>
					</Breadcrumb.Item>
				</Breadcrumb.List>
			</Breadcrumb.Root>
			<h1 class="text-xl font-semibold">New agent</h1>
		</div>
		<AgentEditor agent={null} groups={data.groups} mappings={data.mappings} tools={data.tools} />
	</div>
</div>
