<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button/index.js';
	import BellRingIcon from '@lucide/svelte/icons/bell-ring';
	import SettingsHeader from '$lib/components/app/settings/SettingsHeader.svelte';
	import SettingsSection from '$lib/components/app/settings/SettingsSection.svelte';
	import SettingsRow from '$lib/components/app/settings/SettingsRow.svelte';
	import * as Select from '$lib/components/ui/select/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import { devicePrefs, type DevicePrefs } from '$lib/notifications/prefs.svelte.js';
	import {
		desktopPermission,
		requestDesktopPermission,
		showDesktopNotice,
		type DesktopPermission
	} from '$lib/notifications/desktop.js';
	import {
		SOUND_TONES,
		SOUND_TONE_LABEL,
		playTone,
		type SoundTone
	} from '$lib/notifications/sound.js';
	import { NOTIFICATION_TRIGGER_KEYS, type NotificationTriggers } from '$lib/user-settings.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const prefs = $derived(devicePrefs.current);
	let permission = $state<DesktopPermission>('default');
	let triggerBusy = $state(false);

	onMount(() => {
		devicePrefs.load();
		permission = desktopPermission();
		// Permission can change from the browser's site settings while we're open.
		const refresh = () => (permission = desktopPermission());
		window.addEventListener('focus', refresh);
		return () => window.removeEventListener('focus', refresh);
	});

	const TRIGGER_COPY: Record<keyof NotificationTriggers, { label: string; description: string }> = {
		needsYou: {
			label: 'Needs you',
			description: 'A coding task is waiting for your approval or answer.'
		},
		replies: {
			label: 'Replies',
			description: "A chat reply finished while you weren't looking at it."
		},
		codingFinished: {
			label: 'Coding task finished',
			description: 'A coding task completed its run.'
		},
		failures: {
			label: 'Failures',
			description: 'A coding task or agent run failed.'
		},
		agentRuns: {
			label: 'Agent runs',
			description: 'A scheduled or triggered agent run finished successfully.'
		}
	};
	const TRIGGER_ORDER = [
		'needsYou',
		'replies',
		'codingFinished',
		'failures',
		'agentRuns'
	] as const satisfies typeof NOTIFICATION_TRIGGER_KEYS extends readonly (infer K)[] ? K[] : never;

	async function setTrigger(key: keyof NotificationTriggers, value: boolean) {
		if (triggerBusy) return;
		triggerBusy = true;
		try {
			const res = await fetch('/api/user/settings', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ notificationTriggers: { [key]: value } })
			});
			if (!res.ok) throw new Error(`Request failed (${res.status})`);
			await invalidateAll();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to save');
		} finally {
			triggerBusy = false;
		}
	}

	function update(patch: Partial<DevicePrefs>) {
		devicePrefs.update(patch);
	}

	async function setDesktop(enabled: boolean) {
		if (!enabled) {
			update({ desktop: false });
			return;
		}
		permission = await requestDesktopPermission();
		if (permission === 'granted') {
			update({ desktop: true });
		} else {
			update({ desktop: false });
			if (permission === 'denied') {
				toast.error(
					'Notifications are blocked for this site. Allow them in your browser settings.'
				);
			}
		}
	}

	async function sendTest() {
		if (prefs.sound) playTone(prefs.tone, prefs.volume);
		if (!prefs.desktop || permission !== 'granted') {
			toast.info('Desktop notifications are off on this device.');
			return;
		}
		try {
			await showDesktopNotice(
				{ title: 'Chatty', body: 'Notifications are working.', tag: 'test', url: '/' },
				() => undefined
			);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not show a notification');
		}
	}

	const canTest = $derived(prefs.sound || (prefs.desktop && permission === 'granted'));
	const desktopBlocked = $derived(permission === 'unsupported' || permission === 'denied');
	const desktopHint = $derived(
		permission === 'unsupported'
			? "This browser doesn't support notifications."
			: permission === 'denied'
				? 'Blocked for this site. Allow notifications in your browser settings, then come back to this tab.'
				: 'Pop up a system notification when no Chatty tab is focused.'
	);
</script>

<svelte:head><title>Notifications · Settings · Chatty</title></svelte:head>

<SettingsHeader
	title="Notifications"
	description="How Chatty gets your attention when a reply lands or a task needs you. Nothing alerts while you're looking at the conversation."
>
	{#snippet actions()}
		<span title={canTest ? undefined : 'Turn on desktop notifications or a sound first'}>
			<Button variant="outline" onclick={sendTest} disabled={!canTest}>
				<BellRingIcon class="size-4" />
				Send test
			</Button>
		</span>
	{/snippet}
</SettingsHeader>

<SettingsSection title="Notify me about" description="Applies to all your devices.">
	{#each TRIGGER_ORDER as key (key)}
		<SettingsRow
			label={TRIGGER_COPY[key].label}
			for="trigger-{key}"
			description={TRIGGER_COPY[key].description}
		>
			<Switch
				id="trigger-{key}"
				checked={data.settings.notificationTriggers[key]}
				disabled={triggerBusy}
				onCheckedChange={(checked) => setTrigger(key, checked)}
			/>
		</SettingsRow>
	{/each}
</SettingsSection>

<SettingsSection title="On this device" description="Saved in this browser only.">
	<SettingsRow label="Device notifications" for="pref-desktop">
		{#snippet description()}
			<span class={desktopBlocked ? 'text-amber-700 dark:text-amber-400' : undefined}
				>{desktopHint}</span
			>
		{/snippet}
		<Switch
			id="pref-desktop"
			checked={prefs.desktop && permission === 'granted'}
			disabled={desktopBlocked}
			onCheckedChange={setDesktop}
		/>
	</SettingsRow>
	<!-- Phones have no visible tab title to flash. -->
	<SettingsRow
		class="pointer-coarse:hidden"
		label="Flash the tab title"
		for="pref-flash"
		description="Alternate the title of a background tab until you come back."
	>
		<Switch
			id="pref-flash"
			checked={prefs.titleFlash}
			onCheckedChange={(checked) => update({ titleFlash: checked })}
		/>
	</SettingsRow>
	<SettingsRow
		label="Unread badges"
		for="pref-badge"
		description="Show the count in the tab title, a dot on the tab icon and a badge on the installed app."
	>
		<Switch
			id="pref-badge"
			checked={prefs.badge}
			onCheckedChange={(checked) => update({ badge: checked })}
		/>
	</SettingsRow>
	<SettingsRow
		label="Play a sound"
		for="pref-sound"
		description="A short sound when something needs your attention. Off by default."
	>
		<Switch
			id="pref-sound"
			checked={prefs.sound}
			onCheckedChange={(checked) => {
				update({ sound: checked });
				if (checked) playTone(prefs.tone, prefs.volume);
			}}
		/>
	</SettingsRow>

	{#if prefs.sound}
		<div class="flex flex-col gap-4 rounded-xl bg-muted/50 p-4">
			<SettingsRow label="Tone" for="pref-tone" stack>
				<Select.Root
					type="single"
					value={prefs.tone}
					onValueChange={(value) => {
						update({ tone: value as SoundTone });
						playTone(value as SoundTone, prefs.volume);
					}}
				>
					<Select.Trigger id="pref-tone" class="w-full bg-background sm:w-48">
						{SOUND_TONE_LABEL[prefs.tone]}
					</Select.Trigger>
					<Select.Content>
						{#each SOUND_TONES as tone (tone)}
							<Select.Item value={tone}>{SOUND_TONE_LABEL[tone]}</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
			</SettingsRow>
			<SettingsRow label="Volume" for="pref-volume" stack>
				<div class="flex w-full items-center gap-3 sm:w-48">
					<input
						id="pref-volume"
						type="range"
						min="0"
						max="100"
						step="5"
						class="w-full accent-primary"
						value={Math.round(prefs.volume * 100)}
						oninput={(e) => update({ volume: Number(e.currentTarget.value) / 100 })}
						onchange={() => playTone(prefs.tone, prefs.volume)}
					/>
					<span class="w-10 shrink-0 text-right text-sm text-muted-foreground tabular-nums"
						>{Math.round(prefs.volume * 100)}%</span
					>
				</div>
			</SettingsRow>
			<SettingsRow
				label="Also while Chatty is focused"
				for="pref-sound-focused"
				description="By default the sound only plays when you're in another app or tab."
			>
				<Switch
					id="pref-sound-focused"
					checked={prefs.soundWhenFocused}
					onCheckedChange={(checked) => update({ soundWhenFocused: checked })}
				/>
			</SettingsRow>
		</div>
	{/if}
</SettingsSection>
