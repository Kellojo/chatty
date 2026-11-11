<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { toast } from 'svelte-sonner';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import { Textarea } from '$lib/components/ui/textarea/index.js';
	import * as Select from '$lib/components/ui/select/index.js';
	import SettingsRow from '$lib/components/app/settings/SettingsRow.svelte';
	import SettingsSection from '$lib/components/app/settings/SettingsSection.svelte';
	import BotIcon from '@lucide/svelte/icons/bot';
	import CodeXmlIcon from '@lucide/svelte/icons/code-xml';
	import { EVENT_LABELS, TRIGGER_LABELS } from '$lib/agent-labels.js';
	import { guardUnsavedChanges, isSaveShortcut, missingHint } from '$lib/form-guards.js';
	import ModelSelect from '$lib/components/app/ModelSelect.svelte';
	import CodingContextBar from '$lib/components/app/CodingContextBar.svelte';
	import CodingModelSelect from '$lib/components/app/CodingModelSelect.svelte';
	import CronScheduleInput from '$lib/components/app/CronScheduleInput.svelte';
	import ToolAllowlist from '$lib/components/app/ToolAllowlist.svelte';
	import FormFooter from '$lib/components/app/FormFooter.svelte';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { untrack } from 'svelte';
	import { CodingTaskState } from '$lib/state/coding-task.svelte.js';
	import type { CodingEnvironment } from '$lib/coding-environments.js';
	import type { TimeFormat } from '$lib/user-settings.js';
	import type {
		Agent,
		AgentCanAsk,
		AgentEventName,
		AgentTriggerType,
		ModelMapping,
		ModelsByProvider,
		ToolInfo
	} from '$lib/types.js';
	import { AGENT_CAN_ASK_VALUES, AGENT_EVENT_NAMES } from '$lib/types.js';

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
		// Switching to a schedule starts from every day at 9:00.
		cron: agent?.triggerConfig.cron || '0 9 * * *',
		event: (agent?.triggerConfig.event ?? 'skill.created') as AgentEventName,
		every: String(agent?.triggerConfig.every ?? 1) as string | number,
		instructions: agent?.triggerConfig.instructions ?? '',
		restrictTools: agent?.toolAllowlist != null,
		allowlist: [...(agent?.toolAllowlist ?? [])],
		maxSteps: (agent?.maxSteps?.toString() ?? '') as string | number,
		// New agents may ask by default; existing ones keep what they saved.
		canAsk: (agent?.canAsk ?? 'any') as AgentCanAsk,
		enabled: agent?.enabled ?? true
	});

	let busy = $state(false);

	// Why the save button is disabled, shown next to it.
	const missing = $derived.by(() => {
		const hint = missingHint(
			[
				!form.name.trim() && 'a name',
				!form.systemPrompt.trim() && (coding ? 'a task' : 'a system prompt'),
				form.triggerType === 'schedule' && !form.cron.trim() && 'a schedule'
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

	const triggerHelp = $derived(
		{
			persona: 'Pick it in the chat top bar to talk to it.',
			schedule: 'Runs automatically on a repeating schedule.',
			http: 'Runs when another service calls its endpoint.',
			manual: 'Runs only when you start it.',
			event: 'Runs when something happens in Chatty.'
		}[form.triggerType]
	);

	const CAN_ASK_OPTIONS: Record<AgentCanAsk, { label: string; description: string }> = {
		never: { label: 'Never', description: 'Runs stay in the background.' },
		approvals: { label: 'Only for approvals', description: 'Asks before risky actions.' },
		any: { label: 'Any time', description: 'Asks whenever it needs your input.' }
	};

	// Coding agents ask inside their coding task, and personas don't run on their own.
	const showCanAsk = $derived(!coding && form.triggerType !== 'persona');

	const availableToolNames = $derived(new Set(tools.map((t) => t.name)));
	const allowedToolCount = $derived(form.allowlist.filter((n) => availableToolNames.has(n)).length);

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
						? {
								cron: form.cron.trim(),
								...(form.instructions.trim() ? { instructions: form.instructions.trim() } : {})
							}
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
				// Left out when hidden, so the server keeps (or defaults) the value.
				canAsk: showCanAsk ? form.canAsk : undefined,
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
				// Reload the list: data preloaded earlier (e.g. hovering the back link)
				// predates the new agent.
				await goto(resolve('/agents'), { invalidateAll: true });
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
			: 'What you see about the agent, and what it is told.'}
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
			{#if readonly}
				<!-- Built-ins can't be edited; show the whole text instead of a clipped one-line field. -->
				<p
					id="agent-description"
					class="rounded-3xl border border-dashed border-border px-3 py-2 text-sm text-pretty"
				>
					{form.description || 'No description'}
				</p>
			{:else}
				<Input
					id="agent-description"
					bind:value={form.description}
					maxlength={500}
					aria-describedby="agent-description-hint"
					placeholder="What this agent does"
				/>
				<p id="agent-description-hint" class="text-sm text-muted-foreground">
					Shown in the agent list and to other agents. The agent itself never sees it.
				</p>
			{/if}
		</div>
		<div class="flex flex-col gap-2">
			<Label for="agent-system-prompt">
				{coding ? 'Task' : 'System prompt'}
			</Label>
			<Textarea
				id="agent-system-prompt"
				bind:value={form.systemPrompt}
				rows={8}
				maxlength={20000}
				{readonly}
				required
				aria-describedby="agent-system-prompt-hint"
				class="text-sm {readonly ? '' : 'min-h-40'}"
				placeholder={coding
					? 'Update outdated dependencies, run the tests and open a pull request.'
					: 'You are a concise research assistant. Cite sources and keep answers short.'}
			/>
			<p id="agent-system-prompt-hint" class="text-sm text-muted-foreground">
				{coding
					? "Sent to the coding agent as the first message of every run, followed by the run's instructions."
					: form.triggerType === 'persona'
						? 'Standing rules: who it is and how it behaves in every chat.'
						: 'Standing rules: who it is and how it behaves, in every run and chat. Put the job itself in Run instructions.'}
			</p>
		</div>
		{#if form.triggerType !== 'persona'}
			<div class="flex flex-col gap-2">
				<Label for="agent-instructions">
					Run instructions <span class="font-normal text-muted-foreground">(optional)</span>
				</Label>
				<Textarea
					id="agent-instructions"
					bind:value={form.instructions}
					rows={3}
					maxlength={4000}
					{readonly}
					aria-describedby="agent-instructions-hint"
					placeholder={coding
						? 'e.g. Only touch the frontend packages this time.'
						: 'e.g. Summarise what changed since the last run.'}
				/>
				<p id="agent-instructions-hint" class="text-sm text-muted-foreground">
					{coding
						? 'Added after the task in each run.'
						: `The task for each run, sent as its first message. When empty, the agent is just told “Execute your task now. Trigger: ${form.triggerType}.”`}
				</p>
			</div>
		{/if}
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
		<SettingsSection
			title="Model"
			description="What the agent thinks with, and how long a run may go."
		>
			{#if readonly}
				<!-- Read-only values stack like the Basics fields. -->
				<div class="flex flex-col gap-2">
					<Label for="agent-model">Runs on</Label>
					<Input
						id="agent-model"
						readonly
						value={form.modelValue
							? form.modelValue.split('/').slice(1).join('/')
							: 'Default chat model'}
					/>
				</div>
			{:else}
				<SettingsRow label="Runs on" description="Which model the agent uses." stack>
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
				description="Tool calls per run before the agent stops."
				stack
			>
				{#if readonly}
					<!-- Read-only: the effective value, not a placeholder that looks empty. -->
					<p
						id="agent-max-steps"
						class="w-full rounded-3xl border border-dashed border-border px-3 py-2 text-sm sm:w-36"
					>
						{form.maxSteps === '' ? '25' : form.maxSteps}
					</p>
				{:else}
					<Input
						id="agent-max-steps"
						type="number"
						min={1}
						max={100}
						bind:value={form.maxSteps}
						placeholder="Default (25)"
						class="w-full sm:w-36"
					/>
				{/if}
			</SettingsRow>
		</SettingsSection>
	{/if}

	<SettingsSection title="Trigger" description="How this agent gets started.">
		<SettingsRow label="Starts" description={triggerHelp} stack>
			<Select.Root type="single" bind:value={form.triggerType} disabled={readonly}>
				<Select.Trigger
					class="w-full sm:w-56 {readonly
						? 'disabled:border-dashed disabled:border-border disabled:bg-transparent disabled:opacity-100 [&>svg:last-child]:hidden'
						: ''}"
					aria-label="Trigger type"
				>
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
			<CronScheduleInput bind:value={form.cron} {timeFormat} {readonly} />
		{:else if form.triggerType === 'event'}
			<SettingsRow label="Event" stack>
				<Select.Root type="single" bind:value={form.event} disabled={readonly}>
					<Select.Trigger
						class="w-full sm:w-72 {readonly
							? 'disabled:border-dashed disabled:border-border disabled:bg-transparent disabled:opacity-100 [&>svg:last-child]:hidden'
							: ''}"
						aria-label="Event"
					>
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
				description={readonly
					? 'How many matching events pass between runs.'
					: 'Set to 1 to run on every event, 5 to run on every fifth.'}
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
		{#if showCanAsk}
			<SettingsRow
				label="Can ask you questions"
				description="{CAN_ASK_OPTIONS[form.canAsk].description}{form.canAsk === 'never'
					? ''
					: ' Runs appear as chats you can reply to.'}"
				stack
			>
				<Select.Root type="single" bind:value={form.canAsk} disabled={readonly}>
					<Select.Trigger
						class="w-full sm:w-56 {readonly
							? 'disabled:border-dashed disabled:border-border disabled:bg-transparent disabled:opacity-100 [&>svg:last-child]:hidden'
							: ''}"
						aria-label="Can ask you questions"
					>
						{CAN_ASK_OPTIONS[form.canAsk].label}
					</Select.Trigger>
					<Select.Content>
						{#each AGENT_CAN_ASK_VALUES as option (option)}
							<Select.Item value={option}>{CAN_ASK_OPTIONS[option].label}</Select.Item>
						{/each}
					</Select.Content>
				</Select.Root>
			</SettingsRow>
		{/if}
		<!-- Existing agents are turned on and off from the page header; only
			automatic triggers care about it. -->
		{#if !agent && (form.triggerType === 'schedule' || form.triggerType === 'event')}
			<SettingsRow
				label="Enabled"
				for="agent-enabled"
				description="Turn off to set it up now and start the runs later."
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
		<SettingsSection title="Tools" description="What the agent can use, and what it can change.">
			<SettingsRow
				label="Restrict tools"
				for="restrict-tools"
				description={form.restrictTools
					? `${allowedToolCount} of ${tools.length} allowed. Tools added later stay off until you tick them.`
					: 'The agent can use every tool, including ones from servers you add later.'}
			>
				<Switch
					id="restrict-tools"
					checked={form.restrictTools}
					disabled={readonly}
					onCheckedChange={(v) => (form.restrictTools = v)}
				/>
			</SettingsRow>
			{#if form.restrictTools}
				<div class="border-t border-border/60 pt-4">
					<ToolAllowlist {tools} bind:value={form.allowlist} disabled={readonly} />
				</div>
			{/if}
		</SettingsSection>
	{/if}

	{#if !readonly}
		<FormFooter
			saveLabel={agent ? 'Save changes' : 'Create agent'}
			busyLabel={agent ? 'Saving…' : 'Creating…'}
			{canSave}
			{busy}
			{missing}
			dirty={!!agent && dirty}
			onsave={save}
			ondiscard={agent ? discardChanges : undefined}
			cancel={agent ? undefined : resolve('/agents')}
		/>
	{/if}
</div>
