import { SILENT_WAV } from './speech-playback.svelte.js';

/**
 * Audio for voice mode, shared so it can be unlocked on the click that starts
 * it, even when that click is on another page (the new-chat page): Safari only
 * lets an element play, or an AudioContext run, that a user gesture started.
 */
let players: HTMLAudioElement[] | null = null;

/** One plays while the next two load (the speaker fetches two ahead). */
const PLAYERS = 3;
const createPlayers = () => Array.from({ length: PLAYERS }, () => new Audio());
let context: AudioContext | null = null;

/** Creates and unlocks voice mode's audio. Call it during the click that starts voice mode. */
export function unlockVoiceAudio() {
	players ??= createPlayers();
	for (const el of players) {
		el.src = SILENT_WAV;
		el.play().catch(() => {});
	}
	context ??= new AudioContext();
	void context.resume().catch(() => {});
}

/** The elements the speaker takes turns with: one plays while the others load. */
export function voicePlayers(): HTMLAudioElement[] {
	players ??= createPlayers();
	return players;
}

/** The AudioContext the microphone is measured with. */
export function voiceAudioContext(): AudioContext {
	context ??= new AudioContext();
	if (context.state === 'suspended') void context.resume().catch(() => {});
	return context;
}
