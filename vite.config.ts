import { existsSync } from 'node:fs';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { SvelteKitPWA } from '@vite-pwa/sveltekit';

export default defineConfig(({ mode }) => {
	if (mode !== 'test' && existsSync('.env')) process.loadEnvFile();

	return {
		define: {
			__VERSION__: JSON.stringify(process.env.npm_package_version)
		},
		plugins: [
			tailwindcss(),
			sveltekit({
				compilerOptions: {
					// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
					runes: ({ filename }) =>
						filename.split(/[/\\]/).includes('node_modules') ? undefined : true
				},

				csp: {
					mode: 'nonce',
					directives: {
						'default-src': ['self'],
						'script-src': ['self'],
						// 'unsafe-inline' is required for Svelte's inline style attributes;
						// it is ignored by browsers when a nonce/hash is present, so we
						// keep style-src nonce-free on purpose.
						'style-src': ['self', 'unsafe-inline'],
						'img-src': ['self', 'data:', 'blob:', 'https:'],
						'font-src': ['self', 'data:'],
						'connect-src': ['self'],
						'worker-src': ['self'],
						'manifest-src': ['self'],
						'object-src': ['none'],
						'base-uri': ['self'],
						'form-action': ['self'],
						'frame-ancestors': ['none']
					}
				},

				// adapter-auto only supports some environments, see https://svelte.dev/docs/kit/adapter-auto for a list.
				// If your environment is not supported, or you settled on a specific environment, switch out the adapter.
				// See https://svelte.dev/docs/kit/adapters for more information about adapters.
				adapter: adapter()
			}),
			SvelteKitPWA({
				registerType: 'autoUpdate',
				injectRegister: 'script',
				manifest: {
					name: 'Chatty',
					short_name: 'Chatty',
					description: 'Self-hosted AI chat',
					theme_color: '#0a0a0a',
					background_color: '#0a0a0a',
					display: 'standalone',
					start_url: '/',
					icons: [
						{ src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
						{ src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
						{
							src: '/pwa-maskable-512x512.png',
							sizes: '512x512',
							type: 'image/png',
							purpose: 'maskable'
						}
					]
				},
				workbox: {
					// Serve the precached app shell for navigations when offline.
					navigateFallback: '/',
					// HTML/data payloads can exceed the default 2 MiB precache limit.
					maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
					runtimeCaching: [
						{
							// Offline history browsing: sidebar conversation lists.
							urlPattern: ({ url, request }) =>
								request.method === 'GET' &&
								url.origin === self.location.origin &&
								/^\/api\/conversations(?:\/search)?$/.test(url.pathname),
							handler: 'NetworkFirst',
							options: {
								cacheName: 'api-conversations',
								networkTimeoutSeconds: 5,
								expiration: { maxEntries: 50, maxAgeSeconds: 7 * 24 * 60 * 60 }
							}
						},
						{
							// Individual conversation transcripts for offline reading.
							urlPattern: ({ url, request }) =>
								request.method === 'GET' &&
								url.origin === self.location.origin &&
								/^\/api\/conversations\/[^/]+$/.test(url.pathname),
							handler: 'NetworkFirst',
							options: {
								cacheName: 'api-conversation-detail',
								networkTimeoutSeconds: 5,
								expiration: { maxEntries: 100, maxAgeSeconds: 7 * 24 * 60 * 60 }
							}
						}
					]
				},
				devOptions: {
					enabled: false
				}
			})
		],
		test: {
			expect: { requireAssertions: true },
			projects: [
				{
					extends: './vite.config.ts',
					test: {
						name: 'client',
						browser: {
							enabled: true,
							provider: playwright(),
							instances: [{ browser: 'chromium', headless: true }]
						},
						include: ['src/**/*.svelte.{test,spec}.{js,ts}'],
						exclude: ['src/lib/server/**']
					}
				},

				{
					extends: './vite.config.ts',
					test: {
						name: 'server',
						environment: 'node',
						include: ['src/**/*.{test,spec}.{js,ts}'],
						exclude: ['src/**/*.svelte.{test,spec}.{js,ts}']
					}
				}
			]
		}
	};
});
