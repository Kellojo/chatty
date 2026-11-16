<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import SettingsHeader from '$lib/components/app/settings/SettingsHeader.svelte';
	import SettingsSection from '$lib/components/app/settings/SettingsSection.svelte';
	import SettingsRow from '$lib/components/app/settings/SettingsRow.svelte';
	import ModelSelect from '$lib/components/app/ModelSelect.svelte';
	import SpeechPreviewButton from '$lib/components/app/settings/SpeechPreviewButton.svelte';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { createSpeechPlayback } from '$lib/state/speech-playback.svelte.js';
	import type { ModelRole } from '$lib/types.js';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import { MODEL_ROLE_LABEL } from '$lib/model-roles.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const roleDescriptions: { role: ModelRole; label: string; description: string }[] = [
		{
			role: 'chat',
			label: MODEL_ROLE_LABEL['chat'],
			description: 'Used for new conversations when no model has been picked yet.'
		},
		{
			role: 'title',
			label: MODEL_ROLE_LABEL['title'],
			description: "Generates conversation titles. Uses the chat's own model when unset."
		},
		{
			role: 'memory',
			label: MODEL_ROLE_LABEL['memory'],
			description: 'Turns past chats into memory concepts in the background.'
		},
		{
			role: 'image',
			label: MODEL_ROLE_LABEL['image'],
			description: 'Used when the assistant creates images. Pick a model with the image capability.'
		},
		{
			role: 'compaction',
			label: MODEL_ROLE_LABEL['compaction'],
			description:
				"Summarizes long chats near the context limit. Uses the chat's own model when unset; a cheap model works well."
		},
		{
			role: 'speech-to-text',
			label: MODEL_ROLE_LABEL['speech-to-text'],
			description:
				"Transcribes voice input. When unset, the browser's built-in speech recognition is used instead."
		},
		{
			role: 'text-to-speech',
			label: MODEL_ROLE_LABEL['text-to-speech'],
			description: "Reads replies aloud. When unset, the browser's built-in voice is used instead."
		},
		{
			role: 'decisions',
			label: MODEL_ROLE_LABEL['decisions'],
			description:
				'Used by the Decisions API. Pick a model with the decisions capability. Until one is set, Decisions API calls fail.'
		}
	];

	/** What a private chat does instead when this role's model may not see private data. */
	const PRIVATE_ROLE_NOTE: Partial<Record<ModelRole, string>> = {
		title:
			'This model may not process private data, so private chats use their own model or a placeholder title.',
		compaction:
			'This model may not process private data, so private chats summarize with their own model or not at all.',
		memory:
			'This model may not process private data, so memory runs skip private chats and private notes.',
		image: 'This model may not process private data, so private chats cannot create images.',
		'speech-to-text':
			'This model may not process private data, so dictation is off in private chats.',
		'text-to-speech':
			'This model may not process private data, so private chats only read aloud with on-device voices.'
	};

	const roleCapability: Partial<Record<ModelRole, string>> = {
		image: 'image',
		'speech-to-text': 'transcription',
		'text-to-speech': 'speech',
		decisions: 'decisions'
	};

	let busy = $state<ModelRole | null>(null);

	const modelsById = $derived(new Map(data.models.map((m) => [m.id, m])));

	const enabledGroups = $derived(
		data.providers
			.filter((p) => p.enabled)
			.map((p) => ({
				provider: p,
				models: data.models.filter((m) => m.providerId === p.id && m.enabled)
			}))
			.filter((g) => g.models.length > 0)
	);

	function roleValue(modelId: string | undefined): string {
		if (!modelId) return '';
		if (modelId.startsWith('mapping:')) {
			const mapping = data.mappings.find((m) => `mapping:${m.id}` === modelId);
			return mapping ? `${modelId}/${mapping.name}` : '';
		}
		const model = modelsById.get(modelId);
		return model ? `${model.providerId}/${model.modelId}` : '';
	}

	function modelIdFromValue(value: string): string | null {
		if (!value) return null;
		if (value.startsWith('mapping:')) return value.split('/')[0];
		const model = data.models.find((m) => `${m.providerId}/${m.modelId}` === value);
		return model?.id ?? null;
	}

	// Edited locally, saved on blur or Enter; follows the saved value when page data reloads.
	let voice = $derived(data.ttsVoice);
	let voiceBusy = $state(false);

	/** The voices the Text to speech model offers, or null to type a name instead. */
	const voiceList = $derived(data.ttsVoices);
	/** What an empty setting reads with, as the server picks it (see pickVoice). */
	const modelDefaultVoice = $derived(
		voiceList
			? (voiceList.defaultVoice ??
					(voiceList.voices.includes(data.fallbackVoice)
						? data.fallbackVoice
						: voiceList.voices[0]))
			: data.fallbackVoice
	);
	/** A saved voice this model doesn't offer: the model's default is used instead. */
	const unavailableVoice = $derived(
		voiceList && data.ttsVoice && !voiceList.voices.includes(data.ttsVoice) ? data.ttsVoice : null
	);

	// Voice samples play through the Text to speech model at the user's volume.
	const preview = createSpeechPlayback({
		serverTts: () => true,
		onerror: (message) => toast.error(message),
		volume: () => page.data.settings?.speechVolume ?? 1,
		// A sample text, not chat content.
		privacy: () => ({ private: false })
	});
	onMount(() => preview.stop);
	const sampleText = (name: string) => `Hi, I'm ${name}. This is how replies will sound.`;
	/** The voice replies read with now: the saved one if offered, else the model's default. */
	const previewVoice = $derived(
		voiceList
			? !data.ttsVoice || unavailableVoice
				? modelDefaultVoice
				: data.ttsVoice
			: voice.trim() || undefined
	);

	async function saveVoice(value = voice) {
		const next = value.trim();
		if (voiceBusy || next === data.ttsVoice) return;
		voiceBusy = true;
		try {
			const res = await fetch('/api/speech/voice', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ voice: next })
			});
			if (!res.ok) {
				const payload = (await res.json().catch(() => null)) as { message?: string } | null;
				throw new Error(payload?.message ?? `Request failed (${res.status})`);
			}
			toast.success(next ? 'Voice updated' : 'Voice reset');
			await invalidateAll();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to update voice');
			voice = data.ttsVoice;
		} finally {
			voiceBusy = false;
		}
	}

	async function setRole(role: ModelRole, value: string) {
		if (busy) return;
		busy = role;
		try {
			const res = await fetch('/api/roles', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ role, modelId: modelIdFromValue(value) })
			});
			if (!res.ok) {
				const payload = (await res.json().catch(() => null)) as { message?: string } | null;
				throw new Error(payload?.message ?? `Request failed (${res.status})`);
			}
			toast.success(
				value ? `${MODEL_ROLE_LABEL[role]} updated` : `${MODEL_ROLE_LABEL[role]} cleared`
			);
			await invalidateAll();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to update default');
		} finally {
			busy = null;
		}
	}
</script>

<svelte:head><title>Defaults · Settings · Chatty</title></svelte:head>

<SettingsHeader
	title="Defaults"
	description="Pick which model serves each purpose. One model can serve all of them."
/>

{#if enabledGroups.length === 0}
	<SettingsSection>
		<div class="flex flex-col items-start gap-3 py-2">
			<p class="text-sm text-muted-foreground">
				No enabled models yet. Connect a provider and sync its models first.
			</p>
			<Button size="sm" href={resolve('/settings/providers')}>Go to providers</Button>
		</div>
	</SettingsSection>
{:else}
	<SettingsSection>
		{#each roleDescriptions as { role, label, description } (role)}
			<SettingsRow {label} {description} stack>
				<ModelSelect
					groups={enabledGroups}
					mappings={data.mappings}
					value={roleValue(data.roles[role])}
					onselect={(value) => setRole(role, value)}
					disabled={busy !== null}
					noneValue=""
					noneLabel="Not set"
					capability={roleCapability[role]}
					class="w-full sm:w-72 max-md:[&_[data-model-source]]:hidden"
				/>
				{#if data.untrustedRoles.includes(role)}
					<p
						class="mt-1.5 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400"
						role="note"
					>
						<ShieldAlertIcon class="mt-px size-3.5 shrink-0" aria-hidden="true" />
						<span>{PRIVATE_ROLE_NOTE[role]}</span>
					</p>
				{/if}
			</SettingsRow>
			{#if role === 'text-to-speech' && data.roles['text-to-speech']}
				<!-- A setting of the Text to speech model above, so it hangs off that row. -->
				<SettingsRow
					label="Voice"
					for="tts-voice"
					description={voiceList
						? unavailableVoice
							? `This model doesn't offer “${unavailableVoice}”, so it reads with ${modelDefaultVoice}.`
							: `${voiceList.voices.length} voices available for this model.`
						: `This provider doesn't list its voices, so type one: e.g. alloy or nova for OpenAI, af_heart for Kokoro. Empty uses ${data.fallbackVoice}.`}
					stack
					class="ml-1 border-t-0 border-l-2 pt-0 pl-4"
				>
					{#if voiceList}
						<Select.Root
							type="single"
							value={unavailableVoice ? '' : data.ttsVoice}
							onValueChange={(value) => {
								// Picking a voice plays a sample of it while it saves.
								preview.play(
									'settings-preview',
									sampleText(value || modelDefaultVoice),
									value || modelDefaultVoice
								);
								void saveVoice(value);
							}}
						>
							<Select.Trigger id="tts-voice" class="w-full sm:w-72" disabled={voiceBusy}>
								<span class="truncate">
									{data.ttsVoice && !unavailableVoice
										? data.ttsVoice
										: `Model default (${modelDefaultVoice})`}
								</span>
							</Select.Trigger>
							<Select.Content class="max-h-80">
								<Select.Item value="">Model default ({modelDefaultVoice})</Select.Item>
								<Select.Separator />
								{#each voiceList.voices as option (option)}
									<Select.Item value={option}>{option}</Select.Item>
								{/each}
							</Select.Content>
						</Select.Root>
					{:else}
						<Input
							id="tts-voice"
							bind:value={voice}
							placeholder={data.fallbackVoice}
							maxlength={100}
							autocomplete="off"
							spellcheck={false}
							readonly={voiceBusy}
							onblur={() => saveVoice()}
							onkeydown={(e) => {
								if (e.key === 'Enter') {
									e.preventDefault();
									void saveVoice();
								}
							}}
							class="w-full sm:w-72"
						/>
					{/if}
					<SpeechPreviewButton
						playback={preview}
						text={sampleText(previewVoice ?? data.fallbackVoice)}
						voice={previewVoice}
						disabled={voiceBusy}
					/>
				</SettingsRow>
			{/if}
		{/each}
	</SettingsSection>
{/if}
