// Imported into the generated service worker (workbox `importScripts` in
// vite.config.ts). Other apps share text, links and files into Chatty with a
// multipart POST to /share-target (manifest `share_target`). The files can't
// travel in a URL, so they're parked in a cache and the share redirects to the
// new-chat page, which picks them up (src/lib/share-target.ts) and attaches them.
// Keep SHARE_CACHE and the entry names in sync with that module.

const SHARE_CACHE = 'chatty-share-target';

self.addEventListener('fetch', (event) => {
	const url = new URL(event.request.url);
	if (
		event.request.method !== 'POST' ||
		url.origin !== self.location.origin ||
		url.pathname !== '/share-target'
	) {
		return;
	}
	event.respondWith(
		(async () => {
			const target = new URL('/', self.location.origin);
			let form;
			try {
				form = await event.request.formData();
			} catch {
				return Response.redirect(target.href, 303);
			}
			for (const key of ['share_title', 'share_text', 'share_url']) {
				const value = form.get(key);
				if (typeof value === 'string' && value.trim()) target.searchParams.set(key, value);
			}
			const files = form.getAll('files').filter((f) => typeof f !== 'string' && f.size > 0);
			if (files.length > 0) {
				// One share at a time: a new one replaces whatever an earlier share left.
				await caches.delete(SHARE_CACHE);
				const cache = await caches.open(SHARE_CACHE);
				await Promise.all(
					files.map((file, i) =>
						cache.put(
							`/__share-target/${i}`,
							new Response(file, {
								headers: {
									'content-type': file.type || 'application/octet-stream',
									'x-file-name': encodeURIComponent(file.name || `shared-${i + 1}`)
								}
							})
						)
					)
				);
				target.searchParams.set('share_files', String(files.length));
			}
			// A share with nothing usable still opens a new chat.
			if (!target.search) target.searchParams.set('share_text', '');
			return Response.redirect(target.href, 303);
		})()
	);
});
