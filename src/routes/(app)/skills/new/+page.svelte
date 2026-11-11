<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { toast } from 'svelte-sonner';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import PageHeader from '$lib/components/app/PageHeader.svelte';
	import SettingsSection from '$lib/components/app/settings/SettingsSection.svelte';
	import FormFooter from '$lib/components/app/FormFooter.svelte';
	import { guardUnsavedChanges, isSaveShortcut, missingHint } from '$lib/form-guards.js';

	let name = $state('');
	let title = $state('');
	let description = $state('');
	let body = $state('');
	let busy = $state(false);
	// The name follows the title until it is edited by hand.
	let nameEdited = $state(false);
	$effect(() => {
		if (nameEdited) return;
		name = title
			.toLowerCase()
			.replace(/['’]/g, '')
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 64);
	});

	const nameValid = $derived(/^[a-z0-9][a-z0-9-]{0,63}$/.test(name));
	const missing = $derived(
		missingHint(
			[
				!title.trim() && 'a title',
				// The name follows the title, so it's only worth flagging once there is one.
				!!title.trim() && !nameValid && 'a valid name',
				!description.trim() && 'a description'
			],
			'create'
		)
	);
	const dirty = $derived(Boolean(title || description || body || (nameEdited && name)));
	// Creating navigates to the new skill on purpose.
	let created = false;
	guardUnsavedChanges(() => dirty && !created);
	let formEl = $state<HTMLFormElement | null>(null);

	function onKeydown(event: KeyboardEvent) {
		if (!isSaveShortcut(event)) return;
		event.preventDefault();
		if (!busy && !missing) formEl?.requestSubmit();
	}

	async function create() {
		if (busy || !nameValid || !title.trim() || !description.trim()) return;
		busy = true;
		try {
			const res = await fetch('/api/skills', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					name: name.trim(),
					title: title.trim(),
					description: description.trim(),
					body
				})
			});
			const data = (await res.json().catch(() => null)) as { message?: string } | null;
			if (!res.ok) throw new Error(data?.message ?? `Request failed (${res.status})`);
			toast.success('Skill created');
			created = true;
			await invalidateAll();
			await goto(resolve(`/skills/${name.trim()}`));
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to create skill');
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>New skill · Chatty</title></svelte:head>
<svelte:window onkeydown={onKeydown} />

<div class="flex min-h-0 flex-1 [scrollbar-gutter:stable] flex-col overflow-y-auto">
	<div class="mx-auto w-full max-w-6xl p-4 md:p-6">
		<div class="flex w-full max-w-4xl flex-col gap-6">
			<PageHeader
				title="New skill"
				back={{ href: resolve('/skills'), label: 'Skills' }}
				description="Instructions the AI loads when a request matches the skill's description."
			/>

			<form
				bind:this={formEl}
				class="flex flex-col gap-6"
				onsubmit={(e) => {
					e.preventDefault();
					void create();
				}}
			>
				<SettingsSection title="Details">
					<div class="grid gap-4 sm:grid-cols-2">
						<div class="flex flex-col gap-2">
							<Label for="title">Title</Label>
							<Input id="title" required placeholder="Meeting notes" bind:value={title} />
						</div>
						<div class="flex flex-col gap-2">
							<Label for="name">Name</Label>
							<Input
								id="name"
								required
								class="font-mono"
								placeholder="meeting-notes"
								aria-invalid={name !== '' && !nameValid}
								aria-describedby="name-hint"
								bind:value={name}
								oninput={() => (nameEdited = true)}
							/>
							<p
								id="name-hint"
								class="text-xs {name && !nameValid ? 'text-destructive' : 'text-muted-foreground'}"
							>
								Lowercase letters, digits and dashes. Used as the folder name.
							</p>
						</div>
					</div>
					<div class="flex flex-col gap-2">
						<Label for="description">Description</Label>
						<!-- Same two-row field as the skill edit page, so the example isn't clipped. -->
						<Textarea
							id="description"
							required
							rows={2}
							class="min-h-0"
							placeholder="Turns a meeting transcript into notes with decisions and action items"
							bind:value={description}
						/>
						<p class="text-xs text-muted-foreground">
							The AI reads this to decide when to load the skill, so say what it's for.
						</p>
					</div>
				</SettingsSection>

				<SettingsSection
					title="Instructions"
					description="Markdown the AI follows once it loads this skill."
				>
					<Textarea
						id="body"
						aria-label="Instructions"
						class="min-h-80 font-mono text-sm"
						placeholder="## Steps&#10;1. …"
						bind:value={body}
					/>
				</SettingsSection>

				<FormFooter
					saveLabel="Create skill"
					busyLabel="Creating…"
					{busy}
					{missing}
					cancel={resolve('/skills')}
				/>
			</form>
		</div>
	</div>
</div>
