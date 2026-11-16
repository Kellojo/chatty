/**
 * Speech in private chats (pure helpers, shared by the speech modules and the
 * chat UI). Private audio and text only go to the server's speech models when
 * those are trusted with private data, or stay on the device:
 * - browser speech recognition is never used (Chrome sends the audio to Google);
 * - browser read-aloud only uses voices that run on the device (`localService`).
 */

/**
 * Which chat a speech request belongs to. `conversationId` lets the server
 * re-read the chat's flag; `private` covers an unsaved new chat (and is ORed
 * with the flag when both are sent). Requests without either are treated as
 * private.
 */
export interface SpeechPrivacy {
	conversationId?: string | null;
	private: boolean;
}

/** The safe default when a caller doesn't say: private. */
export const PRIVATE_SPEECH: SpeechPrivacy = Object.freeze({ private: true });

/** Tooltip for the hidden microphone in a private chat. */
export const PRIVATE_MIC_HINT = 'Set a trusted speech-to-text model to dictate in private chats';

/** The privacy fields of a JSON speech request (`/api/speech/synthesize`). */
export function speechPrivacyBody(p: SpeechPrivacy): {
	conversationId?: string;
	private: boolean;
} {
	return p.conversationId
		? { conversationId: p.conversationId, private: p.private }
		: { private: p.private };
}

/** Adds the privacy fields to a form speech request (`/api/speech/transcribe`). */
export function appendSpeechPrivacy(form: FormData, p: SpeechPrivacy): void {
	if (p.conversationId) form.append('conversationId', p.conversationId);
	form.append('private', p.private ? 'true' : 'false');
}

/** Browser speech recognition may be used: never in a private chat. */
export function canUseBrowserRecognition(isPrivate: boolean): boolean {
	return !isPrivate;
}

/** The voices that run on this device (no audio or text leaves it). */
export function localVoices<V extends { localService: boolean }>(voices: readonly V[]): V[] {
	return voices.filter((v) => v.localService === true);
}

/** An on-device voice for `lang` (else any on-device voice), or null when there is none. */
export function pickLocalVoice<V extends { localService: boolean; lang: string }>(
	voices: readonly V[],
	lang: string
): V | null {
	const local = localVoices(voices);
	const base = lang.toLowerCase().split('-')[0];
	return (
		local.find((v) => v.lang.toLowerCase() === lang.toLowerCase()) ??
		local.find((v) => v.lang.toLowerCase().split(/[-_]/)[0] === base) ??
		local[0] ??
		null
	);
}

/** The browser's on-device voices, or [] without speechSynthesis. */
export function browserLocalVoices(): SpeechSynthesisVoice[] {
	if (typeof window === 'undefined' || !('speechSynthesis' in window)) return [];
	return localVoices(window.speechSynthesis.getVoices());
}

/**
 * Whether the microphone (dictation) is offered. In a private chat only a
 * trusted server speech-to-text model may hear it; otherwise the server model
 * or the browser's recognition.
 */
export function micAvailable(opts: {
	isPrivate: boolean;
	sttTrusted: boolean;
	sttConfigured: boolean;
	/** The browser has speech recognition (only used outside private chats). */
	browserRecognition?: boolean;
}): boolean {
	if (opts.isPrivate) return opts.sttConfigured && opts.sttTrusted;
	return opts.sttConfigured || (opts.browserRecognition ?? true);
}

/**
 * Voice mode needs to hear the user and to answer out loud. In a private chat
 * that takes trusted speech to text, and a way to speak that keeps the reply
 * private: trusted text to speech, or an on-device browser voice.
 */
export function voiceModeAvailable(opts: {
	isPrivate: boolean;
	sttTrusted: boolean;
	sttConfigured: boolean;
	ttsTrusted: boolean;
	ttsConfigured: boolean;
	/** On-device browser voices (`localService`). */
	localVoiceCount: number;
	/** The browser has speechSynthesis at all. */
	browserVoice?: boolean;
}): boolean {
	if (!opts.isPrivate) return true;
	if (!opts.sttConfigured || !opts.sttTrusted) return false;
	return readAloudMode(opts) !== 'hidden';
}

/**
 * How read-aloud works in this chat:
 * - 'server': the Text to speech default;
 * - 'local-browser': the browser, with on-device voices only (private chat);
 * - 'browser': the browser's default voice;
 * - 'hidden': not offered.
 */
export type ReadAloudMode = 'server' | 'local-browser' | 'browser' | 'hidden';

export function readAloudMode(opts: {
	isPrivate: boolean;
	ttsTrusted: boolean;
	ttsConfigured: boolean;
	localVoiceCount: number;
	/** The browser has speechSynthesis at all. */
	browserVoice?: boolean;
}): ReadAloudMode {
	const browserVoice = opts.browserVoice ?? true;
	if (opts.isPrivate) {
		if (opts.ttsConfigured && opts.ttsTrusted) return 'server';
		return browserVoice && opts.localVoiceCount > 0 ? 'local-browser' : 'hidden';
	}
	if (opts.ttsConfigured) return 'server';
	return browserVoice ? 'browser' : 'hidden';
}
