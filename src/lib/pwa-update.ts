// Service worker registration with an "update available" prompt. New versions
// wait (registerType: 'prompt' in vite.config.ts) until the user reloads from
// the toast, so a deploy never reloads the page mid-reply or mid-draft.
import { toast } from 'svelte-sonner';

/** Long-lived tabs and installed apps rarely navigate; check for updates hourly. */
const UPDATE_CHECK_MS = 60 * 60 * 1000;

export async function registerServiceWorker(): Promise<void> {
	if (!('serviceWorker' in navigator)) return;
	const { registerSW } = await import('virtual:pwa-register');
	let prompted = false;
	const updateSW = registerSW({
		immediate: true,
		onNeedRefresh() {
			if (prompted) return;
			prompted = true;
			toast('A new version of Chatty is available', {
				duration: Number.POSITIVE_INFINITY,
				action: { label: 'Reload', onClick: () => void updateSW(true) },
				onDismiss: () => (prompted = false)
			});
		},
		onRegisteredSW(_url, registration) {
			if (!registration) return;
			setInterval(() => {
				if (navigator.onLine && !registration.installing) void registration.update();
			}, UPDATE_CHECK_MS);
		}
	});
}
