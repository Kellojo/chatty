<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import SettingsRow from '$lib/components/app/settings/SettingsRow.svelte';
	import SettingsSection from '$lib/components/app/settings/SettingsSection.svelte';
	import BotIcon from '@lucide/svelte/icons/bot';
	import CodeXmlIcon from '@lucide/svelte/icons/code-xml';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import { EVENT_LABELS, TRIGGER_LABELS } from '$lib/agent-labels.js';
	import { describeCron } from '$lib/cron.js';
	import { guardUnsavedChanges, isSaveShortcut, missingHint } from '$lib/form-guards.js';
	import ModelSelect from '$lib/components/app/ModelSelect.svelte';
	import CodingContextBar from '$lib/components/app/CodingContextBar.svelte';
	import CodingModelSelect from '$lib/components/app/CodingModelSelect.svelte';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { untrack } from 'svelte';
	import { CodingTaskState } from '$lib/state/coding-task.svelte.js';
	import type { CodingEnvironment } from '$lib/coding-environments.js';
	import type { TimeFormat } from '$lib/user-settings.js';
	import type {
		Agent,
		AgentEventName,
		AgentTriggerType,
		ModelMapping,
		ModelsByProvider,
		ToolInfo
	} from '$lib/types.js';
	import { AGENT_EVENT_NAMES } from '$lib/types.js';

	let {
		agent,
		groups,
		mappings = [],
		tools,
		codingEnvironments = [],
		timeFormat = '24h',
		readonly = false,
		onreset
	}: {
		agent: Agent | null;
		groups: ModelsByProvider[];
		mappings?: ModelMapping[];
		tools: ToolInfo[];
		codingEnvironments?: CodingEnvironment[];
		timeFormat?: TimeFormat;
		readonly?: boolean;
		/** Discard edits by remounting the editor from the saved agent (resets the coding target too). */
		onreset?: () => void;
	} = $props();

	const allTriggerTypes: AgentTriggerType[] = ['persona', 'schedule', 'http', 'manual', 'event'];

	// Coding agents: each run is a T3 coding task with the saved target. Built-in
	// agents never are, and the option only shows when there is somewhere to run.
	// svelte-ignore state_referenced_locally
	const savedTarget = agent?.codingTarget ?? null;
	// svelte-ignore state_referenced_locally
	const canCode = !readonly && (codingEnvironments.length > 0 || savedTarget !== null);
	// svelte-ignore state_referenced_locally
	const targetEnvironmentMissing =
		savedTarget !== null && !codingEnvironments.some((e) => e.id === savedTarget.environmentId);
	let runsOn = $state<'model' | 'coding'>(savedTarget ? 'coding' : 'model');
	const coding = $derived(runsOn === 'coding');
	const codingTask = new CodingTaskState(
		untrack(() => codingEnvironments),
		{ initial: savedTarget, remember: false }
	);
	let codingInitialized = false;
	$effect(() => {
		if (coding && !codingInitialized) {
			codingInitialized = true;
			untrack(() => codingTask.init());
		}
	});

	const triggerTypes = $derived(
		coding ? allTriggerTypes.filter((t) => t !== 'persona') : allTriggerTypes
	);

	function setRunsOn(value: 'model' | 'coding') {
		runsOn = value;
		if (value === 'coding' && form.triggerType === 'persona') form.triggerType = 'manual';
	}

	// svelte-ignore state_referenced_locally
	let form = $state({
		name: agent?.name ?? '',
		description: agent?.description ?? '',
		systemPrompt: agent?.systemPrompt ?? '',
		modelValue: agent?.providerId && agent?.modelId ? `${agent.providerId}/${agent.modelId}` : '',
		triggerType: (agent?.triggerType ?? 'manual') as AgentTriggerType,
		cron: agent?.triggerConfig.cron ?? '',
		event: (agent?.triggerConfig.event ?? 'skill.created') as AgentEventName,
		every: String(agent?.triggerConfig.every ?? 1) as string | number,
		instructions: agent?.triggerConfig.instructions ?? '',
		restrictTools: agent?.toolAllowlist != null,
		allowlist: [...(agent?.toolAllowlist ?? [])],
		maxSteps: (agent?.maxSteps?.toString() ?? '') as string | number,
		enabled: agent?.enabled ?? true
	});

	let busy = $state(false);

	// Why the save button is disabled, shown next to it.
	const missing = $derived.by(() => {
		const hint = missingHint(
			[
				!form.name.trim() && 'a name',
				!form.systemPrompt.trim() && (coding ? 'a task' : 'a system prompt'),
				form.triggerType === 'schedule' && !form.cron.trim() && 'a cron schedule'
			],
			agent ? 'save' : 'create'
		);
		if (hint) return hint;
		const maxSteps = String(form.maxSteps ?? '').trim();
		if (!coding && maxSteps !== '' && !isIntIn(maxSteps, 1, 100))
			return 'Max steps must be a whole number from 1 to 100.';
		if (form.triggerType === 'event' && !isIntIn(String(form.every ?? '').trim(), 1, 1000))
			return 'The occurrence interval must be a whole number from 1 to 1000.';
		if (coding && !codingTask.draft) return codingTask.blocker ?? 'Choose where it runs.';
		return null;
	});

	function isIntIn(raw: string, min: number, max: number): boolean {
		const value = Number(raw);
		return raw !== '' && Number.isInteger(value) && value >= min && value <= max;
	}

	// The form as loaded or last saved, to tell unsaved edits apart.
	const snapshot = () => JSON.stringify([$state.snapshot(form), runsOn]);
	let baseline = $state(snapshot());
	// The coding target fills in asynchronously; its baseline is the first draft seen.
	const targetSnapshot = () => (coding ? JSON.stringify(codingTask.draft ?? null) : 'null');
	let targetBaseline = $state<string | null>(null);
	$effect(() => {
		if (targetBaseline === null && (!coding || codingTask.draft))
			targetBaseline = untrack(targetSnapshot);
	});
	const dirty = $derived(
		!readonly &&
			(snapshot() !== baseline || (targetBaseline !== null && targetSnapshot() !== targetBaseline))
	);
	const canSave = $derived(!busy && !missing && (!agent || dirty));
	guardUnsavedChanges(() => dirty);

	function discardChanges() {
		if (onreset) {
			onreset();
			return;
		}
		const [savedForm, savedRunsOn] = JSON.parse(baseline) as [typeof form, typeof runsOn];
		Object.assign(form, savedForm);
		runsOn = savedRunsOn;
	}

	function onKeydown(event: KeyboardEvent) {
		if (readonly || !isSaveShortcut(event)) return;
		event.preventDefault();
		if (canSave) void save();
	}

	const cronSummary = $derived(
		form.triggerType === 'schedule' && form.cron.trim()
			? describeCron(form.cron.trim(), timeFormat)
			: null
	);

	const triggerHelp = $derived(
		{
			persona: 'Pick it in the chat top bar to talk to it.',
			schedule: 'Runs on a cron schedule.',
			http: 'Runs when another service calls its endpoint.',
			manual: 'Runs only when you start it.',
			event: 'Runs when something happens in Chatty.'
		}[form.triggerType]
	);

	const toolGroups = $derived.by(() => {
		const groups: { server: string; tools: ToolInfo[] }[] = [];
		for (const tool of tools) {
			const group = groups.find((g) => g.server === tool.server);
			if (group) group.tools.push(tool);
			else groups.push({ server: tool.server, tools: [tool] });
		}
		return groups;
	});

	function toggleTool(name: string, checked: boolean) {
		form.allowlist = checked ? [...form.allowlist, name] : form.allowlist.filter((n) => n !== name);
	}

	async function save() {
		// `missing` already explains anything invalid next to the disabled button.
		if (!canSave) return;
		const draft = codingTask.draft;
		const maxStepsRaw = String(form.maxSteps ?? '').trim();
		// Coding agents hide Max steps, so a leftover value there is ignored.
		const maxSteps = coding || maxStepsRaw === '' ? null : Number(maxStepsRaw);
		const every = form.triggerType === 'event' ? Number(String(form.every ?? '').trim()) : null;
		busy = true;
		try {
			const [providerId, ...rest] = form.modelValue.split('/');
			const body = {
				name: form.name.trim(),
				description: form.description.trim(),
				systemPrompt: form.systemPrompt,
				providerId: form.modelValue ? providerId : null,
				modelId: form.modelValue ? rest.join('/') : null,
				skillNames: agent?.skillNames ?? [],
				toolAllowlist: form.restrictTools ? form.allowlist : null,
				triggerType: form.triggerType,
				triggerConfig:
					form.triggerType === 'schedule'
						? { cron: form.cron.trim() }
						: form.triggerType === 'persona'
							? {}
							: form.triggerType === 'event'
								? {
										event: form.event,
										every: every ?? 1,
										...(form.instructions.trim() ? { instructions: form.instructions.trim() } : {})
									}
								: { instructions: form.instructions.trim() },
				maxSteps,
				// Existing agents toggle from the header; sending the form copy would undo that.
				...(agent ? {} : { enabled: form.enabled }),
				codingTarget:
					coding && draft
						? { ...draft, baseBranch: draft.baseBranch ?? null }
						: savedTarget
							? null
							: undefined
			};
			const res = await fetch(agent ? `/api/agents/${agent.id}` : '/api/agents', {
				method: agent ? 'PATCH' : 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (!res.ok) {
				const payload = (await res.json().catch(() => null)) as { message?: string } | null;
				throw new Error(payload?.message ?? `Request failed (${res.status})`);
			}
			// Saved: leaving is no longer losing anything.
			baseline = snapshot();
			targetBaseline = targetSnapshot();
			if (agent) {
				toast.success('Agent saved');
				await invalidateAll();
				// The saved coding target is read once at mount; remount only when it
				// may have changed, so ordinary saves keep focus and scroll.
				if (coding || savedTarget) onreset?.();
			} else {
				toast.success('Agent created');
				await goto(resolve('/agents'));
			}
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Failed to save agent');
		} finally {
			busy = false;
		}
	}
</script>

<svelte:window onkeydown={onKeydown} />

<div class="flex flex-col gap-6">
	{#if canCode}
		<SettingsSection
			title="Runs on"
			description="A Chatty model with Chatty's tools, or a coding agent working in a repository on a T3 Code environment."
		>
			<div
				class="grid w-full grid-cols-2 rounded-lg border p-0.5 sm:inline-grid sm:w-auto sm:self-start"
				role="radiogroup"
				aria-label="Runs on"
			>
				{#each [{ value: 'model', label: 'Chatty model', icon: BotIcon }, { value: 'coding', label: 'Coding agent', icon: CodeXmlIcon }] as const as option (option.value)}
					<button
						type="button"
						role="radio"
						aria-checked={runsOn === option.value}
						class="flex h-9 items-center justify-center gap-2 rounded-md px-3 text-sm transition-colors md:h-8 {runsOn ===
						option.value
							? 'bg-accent font-medium text-accent-foreground'
							: 'text-muted-foreground hover:text-foreground'}"
						onclick={() => setRunsOn(option.value)}
					>
						<option.icon class="size-4" aria-hidden="true" />
						{option.label}
					</button>
				{/each}
			</div>
		</SettingsSection>
	{/if}

	<SettingsSection
		title="Basics"
		description={coding
			? 'Name, description and the task every run starts with.'
			: 'Name, description and the instructions the agent follows.'}
	>
		<div class="flex flex-col gap-2">
			<Label for="agent-name">Name</Label>
			<Input
				id="agent-name"
				bind:value={form.name}
				maxlength={100}
				{readonly}
				required
				placeholder="Research assistant"
			/>
		</div>
		<div class="flex flex-col gap-2">
			<Label for="agent-description">Description</Label>
			<Input
				id="agent-description"
				bind:value={form.description}
				maxlength={500}
				{readonly}
				placeholder="What this agent does, shown in the agent list"
			/>
		</div>
		<div class="flex flex-col gap-2">
			<Label for="agent-system-prompt">
				{coding ? 'Task' : 'System prompt'}
			</Label>
			<Textarea
				id="agent-system-prompt"
				bind:value={form.systemPrompt}
				rows={8}
				{readonly}
				required
				class="font-mono text-sm {readonly ? '' : 'min-h-40'}"
				placeholder={coding
					? 'Update outdated dependencies, run the tests and open a pull request.'
					: 'You are…'}
			/>
			{#if coding}
				<p class="text-sm text-muted-foreground">
					Sent to the coding agent as the first message of every run, followed by the run's
					instructions.
				</p>
			{/if}
		</div>
	</SettingsSection>

	{#if coding}
		<SettingsSection title="Coding target" description="Where each run starts a coding task.">
			{#if targetEnvironmentMissing}
				<p
					class="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
				>
					<TriangleAlertIcon class="mt-0.5 size-4 shrink-0" />
					The coding environment this agent ran on was removed or disabled. Runs fail until you choose
					another one.
				</p>
			{/if}
			<div class="flex flex-wrap items-center gap-2">
				<CodingModelSelect state={codingTask} disabled={readonly || busy} />
				<CodingContextBar state={codingTask} disabled={readonly || busy} />
			</div>
			{#if !codingTask.draft && codingTask.blocker}
				<p class="text-sm text-muted-foreground">{codingTask.blocker}</p>
			{/if}
			<p class="text-sm text-muted-foreground">
				Runs start without anyone watching. With <span class="font-medium text-foreground"
					>Ask first</span
				>
				the run waits for your approval inside its coding task before running commands or editing.
			</p>
			{#if codingTask.autonomy === 'full-access'}
				<p
					class="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400"
				>
					<TriangleAlertIcon class="mt-0.5 size-4 shrink-0" />
					Full access never asks: every run can run any command and change any file in the project without
					your approval.
				</p>
			{/if}
		</SettingsSection>
	{:else}
		<SettingsSection title="Model">
			{#if readonly}
				<!-- Read-only values stack like the Basics fields. -->
				<div class="flex flex-col gap-2">
					<Label for="agent-model">Model</Label>
					<Input
						id="agent-model"
						readonly
						value={form.modelValue
							? form.modelValue.split('/').slice(1).join('/')
							: 'Default chat model'}
					/>
				</div>
			{:else}
				<SettingsRow label="Model" description="Which model the agent runs on." stack>
					<ModelSelect
						{groups}
						{mappings}
						bind:value={form.modelValue}
						onselect={() => {}}
						noneValue=""
						noneLabel="Default chat model"
						class="w-full sm:w-72"
					/>
				</SettingsRow>
			{/if}
			<SettingsRow
				label="Max steps"
				for="agent-max-steps"
				description="Tool calls per run before the agent stops. Leave empty for 25."
				stack
			>
				<Input
					id="agent-max-steps"
					type="number"
					min={1}
					max={100}
					bind:value={form.maxSteps}
					placeholder="25"
					{readonly}
					class="w-full sm:w-28"
				/>
			</SettingsRow>
		</SettingsSection>
	{/if}

	<SettingsSection title="Trigger" description="How this agent gets started.">
		<SettingsRow label="Starts" description={triggerHelp} stack>
			<Select.Root type="single" bind:value={form.triggerType} disabled={readonly}>
				<Select.Trigger class="w-full sm:w-56" aria-label="Trigger type">
					{TRIGGER_LABELS[form.triggerType]}
				</Select.Trigger>
				<Select.Content>
					{#each triggerTypes as option (option)}
						<Select.Item value={option}>{TRIGGER_LABELS[option]}</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
		</SettingsRow>
		{#if form.triggerType === 'schedule'}
			<SettingsRow
				label="Cron schedule"
				for="agent-cron"
				description="Five fields in the server's time zone, e.g. */30 * * * * for every 30 minutes."
				stack
			>
				<div class="flex w-full flex-col items-stretch gap-1 sm:w-56 sm:items-end">
					<Input
						id="agent-cron"
						bind:value={form.cron}
						{readonly}
						required
						placeholder="*/30 * * * *"
						class="font-mono text-sm"
					/>
					{#if cronSummary}
						<span class="text-xs text-muted-foreground">{cronSummary}</span>
					{/if}
				</div>
			</SettingsRow>
		{:else if form.triggerType === 'event'}
			<SettingsRow label="Event" stack>
				<Select.Root type="single" bind:value={form.event} disabled={readonly}>
					<Select.Trigger class="w-full sm:w-72" aria-label="Event">
						{EVENT_LABELS[form.event]}
					</Select.Trigger>
					<Select.Content>
						{#each AGENT_EVENT_NAMES as option (option)}
							<Select.Item value={option}>{EVENT_LABELS[option]}</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
			</SettingsRow>
			<SettingsRow
				label="Run on every Nth occurrence"
				for="agent-every"
				description="Set to 1 to run on every event, 5 to run on every fifth."
				stack
			>
				<Input
					id="agent-every"
					type="number"
					min={1}
					max={1000}
					bind:value={form.every}
					{readonly}
					class="w-full sm:w-28"
				/>
			</SettingsRow>
		{/if}
		{#if form.triggerType !== 'persona' && form.triggerType !== 'schedule'}
			<div class="flex flex-col gap-2 border-t border-border/60 pt-4">
				<Label for="agent-instructions">Run instructions</Label>
				<Textarea
					id="agent-instructions"
					bind:value={form.instructions}
					rows={4}
					{readonly}
					placeholder="Instructions sent to the agent on each run"
				/>
			</div>
		{/if}
		{#if form.triggerType === 'http'}
			<div class="flex flex-col gap-2 border-t border-border/60 pt-4 text-sm text-muted-foreground">
				<p>
					Call this endpoint with an API key from
					<a
						class="underline underline-offset-4 hover:text-foreground"
						href={resolve('/settings/api')}>API settings</a
					>.
					{#if coding}
						API-key runs of a coding agent always use the saved task; custom instructions are
						rejected.
					{/if}
				</p>
				<code
					class="w-fit max-w-full overflow-x-auto rounded-md bg-muted px-2 py-1 font-mono text-xs"
					>POST /api/agents/{agent?.id ?? '<id>'}/run</code
				>
			</div>
		{/if}
		<!-- Existing agents are turned on and off from the page header. -->
		{#if !agent}
			<SettingsRow
				label="Enabled"
				for="agent-enabled"
				description="Disabled agents never start on their own."
			>
				<Switch
					id="agent-enabled"
					checked={form.enabled}
					onCheckedChange={(v) => (form.enabled = v)}
				/>
			</SettingsRow>
		{/if}
	</SettingsSection>

	{#if !coding}
		<SettingsSection title="Tools">
			<SettingsRow
				label="Restrict tools"
				for="restrict-tools"
				description={form.restrictTools
					? `${form.allowlist.length} of ${tools.length} tools allowed.`
					: 'The agent can use every available tool.'}
			>
				<Switch
					id="restrict-tools"
					checked={form.restrictTools}
					disabled={readonly}
					onCheckedChange={(v) => (form.restrictTools = v)}
				/>
			</SettingsRow>
			{#if form.restrictTools}
				<div class="flex flex-col gap-4 border-t border-border/60 pt-4">
					{#each toolGroups as group (group.server)}
						<fieldset class="flex flex-col gap-1">
							<legend class="pb-1 text-xs font-medium text-muted-foreground">
								{group.server || 'Other'}
							</legend>
							<div class="grid gap-1 sm:grid-cols-2">
								{#each group.tools as tool (tool.name)}
									<label
										class="flex items-start gap-2.5 rounded-lg px-2 py-1.5 text-sm hover:bg-accent/50"
									>
										<input
											type="checkbox"
											class="mt-0.5 size-4 shrink-0 accent-primary"
											checked={form.allowlist.includes(tool.name)}
											disabled={readonly}
											onchange={(e) => toggleTool(tool.name, e.currentTarget.checked)}
										/>
										<span class="min-w-0">
											<span class="block truncate font-mono text-xs font-medium">{tool.name}</span>
											{#if tool.description}
												<span
													class="line-clamp-2 text-xs text-muted-foreground"
													title={tool.description}>{tool.description}</span
												>
											{/if}
										</span>
									</label>
								{/each}
							</div>
						</fieldset>
					{:else}
						<p class="text-sm text-muted-foreground">No tools available.</p>
					{/each}
				</div>
			{/if}
		</SettingsSection>
	{/if}

	{#if !readonly}
		<div
			class="sticky bottom-0 z-10 flex justify-end gap-2 border-t bg-background/95 py-3 backdrop-blur"
		>
			{#if missing || (agent && dirty)}
				<span class="mr-auto self-center text-xs text-muted-foreground"
					>{missing ?? 'Unsaved changes'}</span
				>
			{/if}
			{#if agent}
				{#if dirty}
					<Button variant="outline" onclick={discardChanges}>Discard</Button>
				{/if}
			{:else}
				<Button variant="outline" href={resolve('/agents')}>Cancel</Button>
			{/if}
			<Button onclick={save} disabled={!canSave}>
				{#if busy}<LoaderCircleIcon class="size-4 animate-spin" />{/if}
				{agent ? 'Save changes' : 'Create agent'}
			</Button>
		</div>
	{/if}
</div>
