// Per-device notification preferences. Browser permission, speakers and how
// noisy a machine may be differ per device, so these live in localStorage rather
// than in the account settings (which hold the event triggers).
import { SOUND_TONES, type SoundTone } from './sound.js';

const STORAGE_KEY = 'chatty.notifications';

export interface DevicePrefs {
	/** Desktop notifications when no Chatty tab is focused. */
	desktop: boolean;
	/** Flash the tab title while a hidden tab has news. */
	titleFlash: boolean;
	/** Status dot on the favicon and count on the installed app icon. */
	badge: boolean;
	sound: boolean;
	/** Also play the sound while a Chatty tab is focused. */
	soundWhenFocused: boolean;
	tone: SoundTone;
	/** 0..1 */
	volume: number;
}

export const DEFAULT_DEVICE_PREFS: DevicePrefs = {
	desktop: false,
	titleFlash: true,
	badge: true,
	sound: false,
	soundWhenFocused: false,
	tone: 'chime',
	volume: 0.6
};

export function parseDevicePrefs(raw: string | null): DevicePrefs {
	const prefs = { ...DEFAULT_DEVICE_PREFS };
	if (!raw) return prefs;
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return prefs;
	}
	if (!value || typeof value !== 'object') return prefs;
	const v = value as Record<string, unknown>;
	for (const key of ['desktop', 'titleFlash', 'badge', 'sound', 'soundWhenFocused'] as const) {
		if (typeof v[key] === 'boolean') prefs[key] = v[key];
	}
	if (SOUND_TONES.includes(v.tone as SoundTone)) prefs.tone = v.tone as SoundTone;
	if (typeof v.volume === 'number' && Number.isFinite(v.volume)) {
		prefs.volume = Math.min(1, Math.max(0, v.volume));
	}
	return prefs;
}

function read(): DevicePrefs {
	try {
		return parseDevicePrefs(localStorage.getItem(STORAGE_KEY));
	} catch {
		return { ...DEFAULT_DEVICE_PREFS };
	}
}

class DeviceNotificationPrefs {
	current = $state<DevicePrefs>({ ...DEFAULT_DEVICE_PREFS });
	#loaded = false;

	/** Loads from storage and follows changes made in other tabs. Browser only. */
	load() {
		if (this.#loaded) return;
		this.#loaded = true;
		this.current = read();
		window.addEventListener('storage', (e) => {
			if (e.key === STORAGE_KEY) this.current = read();
		});
	}

	update(patch: Partial<DevicePrefs>) {
		this.current = { ...this.current, ...patch };
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(this.current));
		} catch {
			// storage unavailable (private mode): keep the in-memory value
		}
	}
}

export const devicePrefs = new DeviceNotificationPrefs();
