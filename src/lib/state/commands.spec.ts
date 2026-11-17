import { describe, expect, it } from 'vitest';
import { registerCommands, registeredCommands, type PaletteCommand } from './commands.js';

const command = (id: string, group: PaletteCommand['group']): PaletteCommand => ({
	id,
	label: id,
	group,
	run: () => undefined
});

describe('registerCommands', () => {
	it('groups commands in display order and reads sources on every call', () => {
		let pinned = false;
		const offShell = registerCommands(() => [command('new-chat', 'Actions')]);
		const offChat = registerCommands(() => [
			command(pinned ? 'unpin' : 'pin', 'This chat'),
			command('rename', 'This chat')
		]);
		expect(registeredCommands().map((g) => [g.group, g.commands.map((c) => c.id)])).toEqual([
			['This chat', ['pin', 'rename']],
			['Actions', ['new-chat']]
		]);
		pinned = true;
		expect(registeredCommands()[0].commands[0].id).toBe('unpin');
		offChat();
		expect(registeredCommands().map((g) => g.group)).toEqual(['Actions']);
		offShell();
		expect(registeredCommands()).toEqual([]);
	});

	it('unregisters only its own source', () => {
		const source = () => [command('a', 'Actions')];
		const offA = registerCommands(source);
		const offB = registerCommands(() => [command('b', 'Actions')]);
		offA();
		offA();
		expect(registeredCommands()[0].commands.map((c) => c.id)).toEqual(['b']);
		offB();
		expect(registeredCommands()).toEqual([]);
	});
});
