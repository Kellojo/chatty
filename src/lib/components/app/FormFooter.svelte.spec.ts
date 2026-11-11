import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page as browserPage } from 'vitest/browser';
import '../../../routes/layout.css';

vi.mock('$app/navigation', () => ({
	goto: vi.fn(),
	invalidate: vi.fn(),
	invalidateAll: vi.fn(),
	afterNavigate: vi.fn(),
	beforeNavigate: vi.fn(),
	onNavigate: vi.fn()
}));

const { default: FormFooter } = await import('./FormFooter.svelte');
const { default: FormPageHarness } = await import('./test-harness/FormPageHarness.svelte');
const { default: AgentEditor } = await import('./AgentEditor.svelte');
const { default: MemoryEditForm } = await import('./MemoryEditForm.svelte');

afterEach(() => {
	document.documentElement.classList.remove('dark');
});

describe('FormFooter', () => {
	it('explains what is missing before anything else', async () => {
		const screen = render(FormFooter, {
			saveLabel: 'Create agent',
			canSave: false,
			missing: 'Add a name to create.',
			dirty: true,
			cancel: '/agents'
		});
		await expect.element(screen.getByText('Add a name to create.')).toBeVisible();
		await expect.element(screen.getByText('Unsaved changes')).not.toBeInTheDocument();
		const save = screen.getByRole('button', { name: 'Create agent' });
		await expect.element(save).toBeDisabled();
		await expect.element(save).toHaveAccessibleDescription('Add a name to create.');
		await expect.element(screen.getByRole('link', { name: 'Cancel' })).toBeVisible();
	});

	it('offers Discard only while there are edits', async () => {
		const ondiscard = vi.fn();
		const screen = render(FormFooter, {
			saveLabel: 'Save changes',
			canSave: false,
			dirty: false,
			ondiscard
		});
		await expect.element(screen.getByRole('button', { name: 'Discard' })).not.toBeInTheDocument();
		await screen.rerender({ dirty: true, canSave: true });
		await expect.element(screen.getByText('Unsaved changes')).toBeVisible();
		// It asks first, and keeps the edits when the answer is no.
		const confirm = vi
			.spyOn(window, 'confirm')
			.mockReturnValueOnce(false)
			.mockReturnValueOnce(true);
		await screen.getByRole('button', { name: 'Discard' }).click();
		expect(ondiscard).not.toHaveBeenCalled();
		await screen.getByRole('button', { name: 'Discard' }).click();
		expect(ondiscard).toHaveBeenCalledOnce();
		confirm.mockRestore();
	});

	it('says it is working while busy', async () => {
		const screen = render(FormFooter, {
			saveLabel: 'Create skill',
			busyLabel: 'Creating…',
			busy: true
		});
		// The label stays put (no width jump); the live region says what's happening.
		await expect.element(screen.getByRole('button', { name: 'Create skill' })).toBeDisabled();
		await expect.element(screen.getByText('Creating…')).toBeInTheDocument();
	});

	it('submits its form unless given a save handler', async () => {
		const screen = render(FormFooter, { saveLabel: 'Save changes', canSave: true });
		await expect
			.element(screen.getByRole('button', { name: 'Save changes' }))
			.toHaveAttribute('type', 'submit');
	});
});

// Screenshots of the footer on its pages: `VITE_FORM_FOOTER_SHOTS=<dir> pnpm test:unit -- --run FormFooter`.
const SHOTS = import.meta.env.VITE_FORM_FOOTER_SHOTS as string | undefined;

async function shoot(name: string, width: number, height: number) {
	// The runner scales its iframe down and draws panels over it: lift it out, full size.
	const frame = window.frameElement as HTMLElement | null;
	const host = frame?.parentElement;
	if (host) {
		host.style.transform = 'none';
		host.setAttribute('data-scale', '1');
	}
	if (frame)
		frame.style.cssText = `position:fixed;top:0;left:0;z-index:2147483647;width:${width}px;height:${height}px;border:0;`;
	await new Promise((r) => setTimeout(r, 300));
	await browserPage.screenshot({ path: `${SHOTS}/${name}.png`, scale: 'css' });
}

const VIEWPORTS = [
	{ name: 'desktop', width: 1000, height: 720 },
	{ name: 'mobile', width: 390, height: 844 }
];

describe.skipIf(!SHOTS)('FormFooter screenshots', () => {
	for (const viewport of VIEWPORTS) {
		for (const theme of ['light', 'dark'] as const) {
			it(`agent editor, ${viewport.name}, ${theme}`, async () => {
				if (theme === 'dark') document.documentElement.classList.add('dark');
				document.body.style.margin = '0';
				await browserPage.viewport(viewport.width, viewport.height);
				const screen = render(FormPageHarness, {
					props: {
						height: viewport.height,
						component: AgentEditor,
						props: { agent: null, groups: [], tools: [] }
					}
				});
				const name = screen.container.querySelector<HTMLInputElement>('#agent-name')!;
				name.value = 'Weekly digest';
				name.dispatchEvent(new Event('input', { bubbles: true }));
				await expect.element(screen.getByText('Add a system prompt to create.')).toBeVisible();
				await shoot(`agent-new-${viewport.name}-${theme}`, viewport.width, viewport.height);
			});

			it(`memory editor, ${viewport.name}, ${theme}`, async () => {
				if (theme === 'dark') document.documentElement.classList.add('dark');
				document.body.style.margin = '0';
				await browserPage.viewport(viewport.width, viewport.height);
				const screen = render(FormPageHarness, {
					props: {
						height: viewport.height,
						component: MemoryEditForm,
						props: {
							draft: {
								path: 'people/alex.md',
								type: 'person',
								title: 'Alex',
								description: 'Teammate on the payments project',
								tags: 'work, payments',
								body: 'Prefers async updates over meetings.\n\nWorks from Lisbon, UTC+0.'
							},
							savedPath: 'people/alex.md',
							mode: 'edit',
							scope: 'user',
							dirty: true,
							missing: null,
							canSave: true,
							saveBusy: false,
							onsubmit: (e: SubmitEvent) => e.preventDefault(),
							oncancel: () => {},
							onfilenameedit: () => {}
						}
					}
				});
				await expect.element(screen.getByText('Unsaved changes')).toBeVisible();
				await shoot(`memory-edit-${viewport.name}-${theme}`, viewport.width, viewport.height);
			});
		}
	}
});
