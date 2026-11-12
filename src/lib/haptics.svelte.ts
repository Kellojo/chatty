/**
 * Haptic feedback on touch devices via `web-haptics`: `navigator.vibrate` on Android,
 * and on iOS Safari (no Vibration API) a hidden `<input switch>` toggle, which only
 * buzzes inside a user gesture. Mouse/trackpad devices get nothing.
 *
 * Whether to buzz is a per-device choice (it's about the phone in your hand), so it
 * lives in localStorage rather than in the account settings.
 */
import type { WebHaptics } from 'web-haptics';

export type HapticKind = 'light' | 'medium' | 'selection' | 'success' | 'warning' | 'error';

const STORAGE_KEY = 'chatty.haptics';

let instance: WebHaptics | null = null;
let loading: Promise<WebHaptics | null> | null = null;

/** Whether this device has a touch screen as its main pointer. */
export function isTouchDevice(): boolean {
	return typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
}

function readEnabled(): boolean {
	try {
		return localStorage.getItem(STORAGE_KEY) !== 'off';
	} catch {
		return true;
	}
}

class HapticsPref {
	/** On by default; turned off per device in Settings → Account. */
	enabled = $state(true);
	#loaded = false;

	/** Loads from storage and follows changes made in other tabs. Browser only. */
	load() {
		if (this.#loaded) return;
		this.#loaded = true;
		this.enabled = readEnabled();
		window.addEventListener('storage', (e) => {
			if (e.key === STORAGE_KEY) this.enabled = readEnabled();
		});
	}

	set(enabled: boolean) {
		this.enabled = enabled;
		try {
			localStorage.setItem(STORAGE_KEY, enabled ? 'on' : 'off');
		} catch {
			// storage unavailable (private mode): keep the in-memory value
		}
	}
}

export const hapticsPref = new HapticsPref();

function load(): Promise<WebHaptics | null> {
	loading ??= import('web-haptics')
		.then(({ WebHaptics }) => (instance = new WebHaptics()))
		.catch(() => null);
	return loading;
}

/** Plays a short haptic, if this is a touch device and haptics are on. Never throws. */
export function haptic(kind: HapticKind = 'light'): void {
	if (!hapticsPref.enabled || !isTouchDevice()) return;
	// Synchronous when loaded, so iOS still sees the tap's user activation.
	if (instance) void instance.trigger(kind).catch(() => {});
	else void load().then((h) => h?.trigger(kind).catch(() => {}));
}

/** Reads the setting and loads the library ahead of the first tap (iOS only buzzes within the gesture). */
export function preloadHaptics(): void {
	if (!isTouchDevice()) return;
	hapticsPref.load();
	if (hapticsPref.enabled) void load();
}
