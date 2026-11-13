import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import '../../../routes/layout.css';
import ToolAllowlist from './ToolAllowlist.svelte';
import type { ToolInfo } from '$lib/types.js';

const tools: ToolInfo[] = [
	{ name: 'fs_ls', description: 'List a directory', server: 'fs' },
	{ name: 'fs_write', description: 'Write a file', server: 'fs' },
	{ name: 'fetch', description: 'Fetch a URL', server: 'webfetch' }
];

describe('ToolAllowlist', () => {
	it('shows readable labels and per-group counts', async () => {
		render(ToolAllowlist, { tools, value: ['fs_ls'] });
		await expect.element(page.getByText('List files')).toBeVisible();
		await expect.element(page.getByText('1/2')).toBeVisible();
		await expect.element(page.getByRole('checkbox', { name: /List files/ })).toBeChecked();
	});

	it('allows a whole group from its header checkbox', async () => {
		render(ToolAllowlist, { tools, value: [] });
		await page.getByRole('checkbox', { name: 'Allow every Files tool' }).click();
		await expect.element(page.getByRole('checkbox', { name: /Write file/ })).toBeChecked();
		await expect.element(page.getByRole('checkbox', { name: /Fetch URL/ })).not.toBeChecked();
	});

	it('filters by search and only bulk-allows the matches', async () => {
		render(ToolAllowlist, { tools, value: [] });
		await page.getByRole('searchbox', { name: 'Search tools' }).fill('fetch');
		await expect.element(page.getByText('List files')).not.toBeInTheDocument();
		await page.getByRole('button', { name: 'Allow all matching tools' }).click();
		await page.getByRole('searchbox', { name: 'Search tools' }).fill('');
		await expect.element(page.getByRole('checkbox', { name: /Fetch URL/ })).toBeChecked();
		await expect.element(page.getByRole('checkbox', { name: /List files/ })).not.toBeChecked();
	});

	it('warns when nothing is allowed and lists unavailable tools', async () => {
		render(ToolAllowlist, { tools, value: ['gone_tool'] });
		await expect.element(page.getByText(/No tools allowed/)).toBeVisible();
		await expect.element(page.getByText('gone_tool')).toBeVisible();
		await page.getByRole('button', { name: 'Remove gone_tool' }).click();
		await expect.element(page.getByText('gone_tool')).not.toBeInTheDocument();
	});

	it('groups built-in servers apart from added ones', async () => {
		render(ToolAllowlist, {
			tools: [
				{ name: 'fs_ls', description: 'List a directory', server: 'fs', builtin: true },
				{ name: 'search_issues', description: 'Search issues', server: 'github', builtin: false }
			],
			value: []
		});
		await expect.element(page.getByRole('heading', { name: 'Built-in' })).toBeVisible();
		await expect.element(page.getByRole('heading', { name: 'Added servers' })).toBeVisible();
	});

	it('shows no section headings when every server is of one kind', async () => {
		render(ToolAllowlist, { tools, value: [] });
		await expect.element(page.getByText('List files')).toBeVisible();
		expect(page.getByRole('heading', { name: 'Built-in' }).elements()).toHaveLength(0);
	});
});
