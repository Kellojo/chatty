import { existsSync } from 'node:fs';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { SvelteKitPWA } from '@vite-pwa/sveltekit';

// Files other apps may share into Chatty: the composer's attachment types
// (its file picker's `accept`). Android matches shares by MIME type.
const SHAREABLE_FILES = [
	'image/*',
	'application/pdf',
	'text/*',
	'application/json',
	'application/xml',
	'application/zip',
	'application/msword',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	'application/vnd.ms-excel',
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	'application/vnd.ms-powerpoint',
	'application/vnd.openxmlformats-officedocument.presentationml.presentation',
	'.md',
	'.csv',
	'.json'
];

// Files the desktop app offers to open ("Open with Chatty"). Kept to documents
// you'd ask about; registering every image or text type would crowd the menu.
const OPENABLE_FILES: Record<string, string[]> = {
	'application/pdf': ['.pdf'],
	'text/markdown': ['.md', '.markdown'],
	'text/plain': ['.txt', '.log'],
	'text/csv': ['.csv'],
	'application/json': ['.json'],
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx']
};

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

				// The cross-site form check moves to src/lib/server/csrf.ts, which exempts the
				// OAuth token endpoints other apps' servers post to (no Origin header).
				csrf: { trustedOrigins: ['*'] },

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
				// A new version waits until the user reloads from the update toast
				// (src/lib/pwa-update.ts), so a deploy never reloads mid-reply.
				registerType: 'prompt',
				injectRegister: false,
				manifest: {
					name: 'Chatty',
					short_name: 'Chatty',
					description: 'Self-hosted AI chat',
					theme_color: '#0e0d0c',
					background_color: '#0e0d0c',
					display: 'standalone',
					// Installed on desktop, the app draws into the title bar (the window
					// controls float over it); see --safe-top in src/routes/layout.css.
					display_override: ['window-controls-overlay'],
					start_url: '/',
					// Share text, links and files from other apps into a new chat. The
					// service worker takes the POST (static/share-target-sw.js) and hands
					// it to the new-chat page, src/routes/(app)/+page.svelte.
					share_target: {
						action: '/share-target',
						method: 'POST',
						enctype: 'multipart/form-data',
						params: {
							title: 'share_title',
							text: 'share_text',
							url: 'share_url',
							files: [{ name: 'files', accept: SHAREABLE_FILES }]
						}
					},
					// Desktop "Open with Chatty": the new-chat page attaches the files it is
					// launched with (window.launchQueue).
					file_handlers: [{ action: '/', accept: OPENABLE_FILES }],
					// Long-press / right-click menu on the app icon.
					shortcuts: [
						{ name: 'New chat', short_name: 'Chat', url: '/?mode=chat' },
						{ name: 'New coding task', short_name: 'Coding', url: '/?mode=coding' },
						{ name: 'Agents', short_name: 'Agents', url: '/agents' }
					],
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
					// Server endpoints that are navigated to (OAuth callbacks, file
					// downloads) and the MCP gateway's OAuth approval page must reach
					// the server, not get the cached shell.
					navigateFallbackDenylist: [/^\/api\//, /^\/oauth\//, /^\/\.well-known\//],
					// Notification click handling (see static/notification-sw.js).
					// Shares from other apps (see static/share-target-sw.js).
					importScripts: ['/notification-sw.js', '/share-target-sw.js'],
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
							// Conversation transcripts for offline reading: the chat page's
							// load data, which client navigations fetch as __data.json.
							urlPattern: ({ url, request }) =>
								request.method === 'GET' &&
								url.origin === self.location.origin &&
								/^\/chat\/[^/]+\/__data\.json$/.test(url.pathname),
							handler: 'NetworkFirst',
							options: {
								cacheName: 'chat-page-data',
								networkTimeoutSeconds: 5,
								expiration: { maxEntries: 100, maxAgeSeconds: 7 * 24 * 60 * 60 }
							}
						},
						{
							// Earlier pages of a transcript (keyed by their `before` cursor).
							urlPattern: ({ url, request }) =>
								request.method === 'GET' &&
								url.origin === self.location.origin &&
								/^\/api\/conversations\/[^/]+\/messages$/.test(url.pathname),
							handler: 'NetworkFirst',
							options: {
								cacheName: 'chat-older-messages',
								networkTimeoutSeconds: 5,
								expiration: { maxEntries: 200, maxAgeSeconds: 7 * 24 * 60 * 60 }
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
