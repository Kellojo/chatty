import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Evaluations call real models, so they have their own config and never run
// with `pnpm test`. They need the app's settings (database, secret), which the
// test mode of vite.config.ts does not load.
if (existsSync('.env')) process.loadEnvFile();

export default defineConfig({
	test: {
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'eval',
					environment: 'node',
					include: ['src/**/*.eval.ts'],
					testTimeout: 60 * 60_000,
					expect: { requireAssertions: true }
				}
			}
		]
	}
});
