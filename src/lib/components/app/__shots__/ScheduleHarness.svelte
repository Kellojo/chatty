<script lang="ts">
	import SettingsSection from '$lib/components/app/settings/SettingsSection.svelte';
	import SettingsRow from '$lib/components/app/settings/SettingsRow.svelte';
	import CronScheduleInput from '$lib/components/app/CronScheduleInput.svelte';

	let { value = '', readonly = false }: { value?: string; readonly?: boolean } = $props();
	let cron = $state(value);
</script>

<SettingsSection title="Trigger" description="How this agent gets started.">
	<SettingsRow label="Starts" description="Runs automatically on a schedule." stack>
		<div
			class="flex h-9 w-full items-center rounded-3xl bg-input/50 px-3 text-sm sm:w-56"
		>
			On a schedule
		</div>
	</SettingsRow>
	<CronScheduleInput bind:value={cron} timeFormat="24h" timeZone="Europe/Berlin" {readonly} />
</SettingsSection>
<p data-cron class="mt-2 font-mono text-xs text-muted-foreground">cron: {cron}</p>
