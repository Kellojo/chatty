// TEMPORARY screenshot harness for the theme picker (hill climbing). Delete when done.
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { commands, page as browserPage } from 'vitest/browser';
import '../../../layout.css';
import Page from './+page.svelte';
import Onboarding from '$lib/components/app/onboarding/StepPersonalize.svelte';

const SHOTS = import.meta.env.VITE_THEME_SHOTS as string | undefined;

const FIXED_FONTS = document.createElement('style');
FIXED_FONTS.textContent = '*{font-family:Arial,Helvetica,sans-serif !important}';
document.head.appendChild(FIXED_FONTS);

function css() {
	return [...document.styleSheets]
		.map((sheet) => {
			try {
				return [...sheet.cssRules].map((rule) => rule.cssText).join('\n');
			} catch {
				return '';
			}
		})
		.join('\n');
}

async function shoot(name: string, el: Element, width: number, dark: boolean) {
	await new Promise((r) => setTimeout(r, 300));
	const html = `<!doctype html><html class="${dark ? 'dark' : ''}" style="color-scheme:${dark ? 'dark' : 'light'}"><head><meta charset="utf-8"><style>${css()}</style></head><body style="margin:0;background:var(--background);color:var(--foreground)"><div style="width:${width}px;padding:16px;box-sizing:content-box">${el.outerHTML}</div></body></html>`;
	await commands.writeFile(`${SHOTS}/${name}.html`, html);
}

const data = {
	user: { name: 'Sam Rivera', email: 'sam@example.com', image: null },
	settings: { theme: 'system', timeFormat: 'auto' }
};

describe.skipIf(!SHOTS)('Theme picker shots', () => {
	for (const vp of [
		{ name: 'desktop', width: 990 },
		{ name: 'mobile', width: 358 }
	]) {
		for (const dark of [false, true]) {
			for (const theme of ['system', 'light'] as const) {
				it(`settings-${vp.name}-${dark ? 'dark' : 'light'}-${theme}`, async () => {
					document.documentElement.classList.toggle('dark', dark);
					await browserPage.viewport(vp.width + 32, 2000);
					const screen = render(Page, {
						data: { ...data, settings: { ...data.settings, theme } } as never
					});
					await expect.poll(() => screen.container.textContent).toContain('Theme');
					// Only the Appearance section and its neighbours: the first three sections.
					const wrap = document.createElement('div');
					wrap.className = 'flex flex-col gap-6';
					const sections = [...screen.container.children].slice(0, 4);
					for (const s of sections) wrap.appendChild(s.cloneNode(true));
					await shoot(
						`settings-${vp.name}-${dark ? 'dark' : 'light'}-${theme}`,
						wrap,
						vp.width,
						dark
					);
				});
			}
		}
		it(`onboarding-${vp.name}`, async () => {
			document.documentElement.classList.remove('dark');
			await browserPage.viewport(vp.width + 32, 2000);
			const flow = { theme: 'dark', instructions: '', savedInstructions: '' };
			const screen = render(Onboarding, { flow: flow as never, onback() {}, onnext() {} });
			await expect.poll(() => screen.container.textContent).toContain('Appearance');
			await shoot(`onboarding-${vp.name}`, screen.container, vp.width, false);
		});
	}
});
