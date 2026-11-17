import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page as browserPage } from 'vitest/browser';
import { setMode } from 'mode-watcher';
import '../../../../routes/layout.css';
import Harness from './ScheduleHarness.svelte';

const SHOTS = import.meta.env.VITE_SCHEDULE_SHOTS as string | undefined;
const ROUND = (import.meta.env.VITE_SCHEDULE_ROUND as string | undefined) ?? 'r1';

afterEach(() => {
	document.documentElement.classList.remove('dark');
	setMode('light');
	for (const c of document.querySelectorAll('[data-shot-column]')) c.remove();
});

type Shot = {
	name: string;
	cron: string;
	width?: number;
	dark?: boolean;
	readonly?: boolean;
	open?: string;
};

const STATES: Shot[] = [
	{ name: 'interval-minutes', cron: '*/30 * * * *' },
	{ name: 'interval-hours', cron: '15 */6 * * *' },
	{ name: 'interval-open', cron: '*/30 * * * *', open: '[aria-label="Interval"]' },
	{ name: 'daily-every-day', cron: '0 9 * * *' },
	{ name: 'daily-weekdays', cron: '30 8 * * 1-5' },
	{ name: 'monthly', cron: '0 9 31 * *' },
	{ name: 'time-open', cron: '30 8 * * 1-5', open: '[aria-label="Hour"]' },
	{ name: 'custom', cron: '0 9 1 1 *' },
	{ name: 'custom-invalid', cron: '0 9 * *' },
	{ name: 'readonly-weekdays', cron: '30 8 * * 1-5', readonly: true },
	{ name: 'daily-weekdays-dark', cron: '30 8 * * 1-5', dark: true },
	{ name: 'mobile-weekdays', cron: '30 8 * * 1-5', width: 390 },
	{ name: 'mobile-interval-hours', cron: '15 */6 * * *', width: 390 }
];

describe.skipIf(!SHOTS)('Schedule picker screenshots', () => {
	for (const s of STATES) {
		it(s.name, async () => {
			const width = s.width ?? 1000;
			if (s.dark) {
				document.documentElement.classList.add('dark');
				setMode('dark');
			}
			document.body.style.margin = '0';
			document.body.style.background = 'var(--background)';
			const frame = window.frameElement as HTMLElement | null;
			const host = frame?.parentElement;
			if (host) {
				host.style.transform = 'none';
				host.setAttribute('data-scale', '1');
			}
			if (frame) {
				frame.style.cssText = `position:fixed;top:0;left:0;z-index:2147483647;width:${width}px;height:900px;border:0;`;
			}
			await browserPage.viewport(width, 900);
			const screen = render(Harness, { value: s.cron, readonly: s.readonly });
			const column = document.createElement('div');
			column.dataset.shotColumn = '';
			column.className = 'w-full max-w-4xl bg-background p-4 text-foreground md:p-6';
			screen.container.parentElement!.insertBefore(column, screen.container);
			column.appendChild(screen.container);
			await expect.poll(() => screen.container.textContent?.length ?? 0).toBeGreaterThan(0);
			if (s.open) {
				await browserPage.elementLocator(column.querySelector(s.open)!).click();
				await new Promise((r) => setTimeout(r, 600));
			}
			await new Promise((r) => setTimeout(r, 800));
			const file = `${SHOTS}/${ROUND}-${s.name}.png`;
			if (s.open) await browserPage.screenshot({ path: file, scale: 'css' });
			else await browserPage.screenshot({ path: file, scale: 'css', element: column });
		});
	}
});
