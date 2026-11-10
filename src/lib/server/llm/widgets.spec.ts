import { describe, expect, it } from 'vitest';
import { widgetsPrompt } from './widgets.js';

const fences = (prompt: string) => [...prompt.matchAll(/^- ```(\w+)/gm)].map((m) => m[1]);

describe('widgetsPrompt', () => {
	it('lists the widgets that need no tools', () => {
		expect(fences(widgetsPrompt())).toEqual(['chart', 'map', 'events']);
	});

	it('lists the meal plan widget when a meal planner tool exists', () => {
		expect(fences(widgetsPrompt(['get_week_planned_recipes']))).toContain('mealplan');
		expect(fences(widgetsPrompt(['add_to_plan', 'fetch']))).not.toContain('mealplan');
	});

	it('lists the file widget when the model can write workspace files', () => {
		expect(fences(widgetsPrompt(['fs_write']))).toContain('file');
		expect(fences(widgetsPrompt(['code_exec']))).toContain('file');
		expect(fences(widgetsPrompt(['fs_read']))).not.toContain('file');
	});

	it('keeps a stable order', () => {
		expect(fences(widgetsPrompt(['code_exec', 'list_recipes']))).toEqual([
			'chart',
			'map',
			'events',
			'mealplan',
			'file'
		]);
	});
});
