<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
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

	const desktopHint = $derived(
		permission === 'unsupported'
			? "This browser doesn't support notifications."
			: permission === 'denied'
				? 'Blocked for this site. Allow notifications in your browser settings, then turn this on.'
				: 'Pop up a system notification when no Chatty tab is focused.'
	);
</script>

<svelte:head><title>Notifications · Settings · Chatty</title></svelte:head>

{#snippet row(id: string, label: string, description: string, control: import('svelte').Snippet)}
	<div class="flex items-center justify-between gap-6">
		<div class="flex min-w-0 flex-col gap-1">
			<Label for={id}>{label}</Label>
			<p class="text-sm text-muted-foreground">{description}</p>
		</div>
		{@render control()}
	</div>
{/snippet}

{#snippet desktopControl()}
	<Switch
		id="pref-desktop"
		checked={prefs.desktop && permission === 'granted'}
		disabled={permission === 'unsupported'}
		onCheckedChange={setDesktop}
	/>
{/snippet}

{#snippet flashControl()}
	<Switch
		id="pref-flash"
		checked={prefs.titleFlash}
		onCheckedChange={(checked) => update({ titleFlash: checked })}
	/>
{/snippet}

{#snippet badgeControl()}
	<Switch
		id="pref-badge"
		checked={prefs.badge}
		onCheckedChange={(checked) => update({ badge: checked })}
	/>
{/snippet}

{#snippet soundControl()}
	<Switch
		id="pref-sound"
		checked={prefs.sound}
		onCheckedChange={(checked) => {
			update({ sound: checked });
			if (checked) playTone(prefs.tone, prefs.volume);
		}}
	/>
{/snippet}

{#snippet focusedControl()}
	<Switch
		id="pref-sound-focused"
		checked={prefs.soundWhenFocused}
		onCheckedChange={(checked) => update({ soundWhenFocused: checked })}
	/>
{/snippet}

<div class="flex flex-col gap-4">
	<h2 class="text-xl font-semibold">Notifications</h2>
	<p class="text-sm text-muted-foreground">
		How Chatty gets your attention when a reply lands or a task needs you. Nothing alerts while
		you're looking at the conversation.
	</p>

	<Card.Root>
		<Card.Header>
			<Card.Title>Notify me about</Card.Title>
			<Card.Description>Applies to all your devices.</Card.Description>
		</Card.Header>
		<Card.Content class="flex flex-col gap-4">
			{#each TRIGGER_ORDER as key (key)}
				{#snippet control()}
					<Switch
						id="trigger-{key}"
						checked={data.settings.notificationTriggers[key]}
						disabled={triggerBusy}
						onCheckedChange={(checked) => setTrigger(key, checked)}
					/>
				{/snippet}
				{@render row(
					`trigger-${key}`,
					TRIGGER_COPY[key].label,
					TRIGGER_COPY[key].description,
					control
				)}
			{/each}
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title>On this device</Card.Title>
			<Card.Description>Saved in this browser only.</Card.Description>
		</Card.Header>
		<Card.Content class="flex flex-col gap-4">
			{@render row('pref-desktop', 'Desktop notifications', desktopHint, desktopControl)}

			{@render row(
				'pref-flash',
				'Flash the tab title',
				'Alternate the title of a background tab until you come back.',
				flashControl
			)}

			{@render row(
				'pref-badge',
				'Unread badges',
				'Show the count in the tab title, a dot on the tab icon and a badge on the installed app.',
				badgeControl
			)}
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title>Sound</Card.Title>
			<Card.Description>Off by default. Saved in this browser only.</Card.Description>
		</Card.Header>
		<Card.Content class="flex flex-col gap-4">
			{@render row(
				'pref-sound',
				'Play a sound',
				'Play a short sound when something needs your attention.',
				soundControl
			)}

			{#if prefs.sound}
				<div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
					<div class="flex min-w-0 flex-col gap-1">
						<Label>Tone</Label>
					</div>
					<div class="flex items-center gap-2">
						<Select.Root
							type="single"
							value={prefs.tone}
							onValueChange={(value) => {
								update({ tone: value as SoundTone });
								playTone(value as SoundTone, prefs.volume);
							}}
						>
							<Select.Trigger class="w-full shrink-0 sm:w-40">
								{SOUND_TONE_LABEL[prefs.tone]}
							</Select.Trigger>
							<Select.Content>
								{#each SOUND_TONES as tone (tone)}
									<Select.Item value={tone}>{SOUND_TONE_LABEL[tone]}</Select.Item>
								{/each}
							</Select.Content>
						</Select.Root>
					</div>
				</div>

				<div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
					<Label for="pref-volume">Volume</Label>
					<div class="flex items-center gap-3 sm:w-64">
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
				</div>

				{@render row(
					'pref-sound-focused',
					'Also while Chatty is focused',
					'By default the sound only plays when you are in another app or tab.',
					focusedControl
				)}
			{/if}
		</Card.Content>
	</Card.Root>

	<div class="flex justify-end">
		<Button variant="outline" size="sm" onclick={sendTest}>Send test notification</Button>
	</div>
</div>
