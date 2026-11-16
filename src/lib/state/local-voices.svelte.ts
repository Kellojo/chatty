import { createSubscriber } from 'svelte/reactivity';
import { browserLocalVoices } from '$lib/private-speech.js';

// Browsers load their voices late and announce it with `voiceschanged`.
const subscribe = createSubscriber((update) => {
	if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
	window.speechSynthesis.addEventListener('voiceschanged', update);
	return () => window.speechSynthesis.removeEventListener('voiceschanged', update);
});

/**
 * How many on-device voices (`localService`) the browser has, reactively: a
 * private chat may only read aloud with these when text to speech isn't
 * trusted.
 */
export function localVoiceCount(): number {
	subscribe();
	return browserLocalVoices().length;
}
