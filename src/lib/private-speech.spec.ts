import { describe, expect, it } from 'vitest';
import {
	canUseBrowserRecognition,
	localVoices,
	micAvailable,
	pickLocalVoice,
	readAloudMode,
	voiceModeAvailable
} from './private-speech.js';

const v = (name: string, lang: string, localService: boolean) => ({ name, lang, localService });

describe('private speech', () => {
	it('never uses browser recognition in a private chat', () => {
		expect(canUseBrowserRecognition(true)).toBe(false);
		expect(canUseBrowserRecognition(false)).toBe(true);
	});

	it('keeps only on-device voices, preferring the language', () => {
		const voices = [v('Cloud', 'de-DE', false), v('Anna', 'de-AT', true), v('Sam', 'en-US', true)];
		expect(localVoices(voices).map((x) => x.name)).toEqual(['Anna', 'Sam']);
		expect(pickLocalVoice(voices, 'de-DE')?.name).toBe('Anna');
		expect(pickLocalVoice(voices, 'en-US')?.name).toBe('Sam');
		expect(pickLocalVoice(voices, 'fr-FR')?.name).toBe('Anna');
		expect(pickLocalVoice([v('Cloud', 'en-US', false)], 'en-US')).toBeNull();
	});

	it('offers the mic and voice mode in a private chat only with trusted speech to text', () => {
		const base = { sttConfigured: true, sttTrusted: false };
		expect(micAvailable({ ...base, isPrivate: true })).toBe(false);
		expect(micAvailable({ ...base, isPrivate: true, sttTrusted: true })).toBe(true);
		expect(micAvailable({ isPrivate: false, sttConfigured: false, sttTrusted: false })).toBe(true);
		expect(
			micAvailable({
				isPrivate: false,
				sttConfigured: false,
				sttTrusted: false,
				browserRecognition: false
			})
		).toBe(false);
		const speak = { ttsConfigured: true, ttsTrusted: true, localVoiceCount: 0 };
		expect(voiceModeAvailable({ ...base, ...speak, isPrivate: true })).toBe(false);
		expect(voiceModeAvailable({ ...base, ...speak, isPrivate: false })).toBe(true);
	});

	it('offers voice mode in a private chat only when it can also speak privately', () => {
		const hear = { isPrivate: true, sttConfigured: true, sttTrusted: true };
		// Trusted text to speech.
		expect(
			voiceModeAvailable({ ...hear, ttsConfigured: true, ttsTrusted: true, localVoiceCount: 0 })
		).toBe(true);
		// Untrusted text to speech, no on-device voice: it could listen but not answer.
		expect(
			voiceModeAvailable({ ...hear, ttsConfigured: true, ttsTrusted: false, localVoiceCount: 0 })
		).toBe(false);
		// An on-device browser voice answers instead.
		expect(
			voiceModeAvailable({ ...hear, ttsConfigured: true, ttsTrusted: false, localVoiceCount: 1 })
		).toBe(true);
		expect(
			voiceModeAvailable({
				...hear,
				ttsConfigured: false,
				ttsTrusted: false,
				localVoiceCount: 1,
				browserVoice: false
			})
		).toBe(false);
		// Public chats don't need either.
		expect(
			voiceModeAvailable({
				...hear,
				isPrivate: false,
				ttsConfigured: false,
				ttsTrusted: false,
				localVoiceCount: 0
			})
		).toBe(true);
	});

	it('picks how to read aloud', () => {
		const p = { isPrivate: true, ttsConfigured: true, ttsTrusted: true, localVoiceCount: 0 };
		expect(readAloudMode(p)).toBe('server');
		expect(readAloudMode({ ...p, ttsTrusted: false, localVoiceCount: 2 })).toBe('local-browser');
		expect(readAloudMode({ ...p, ttsTrusted: false })).toBe('hidden');
		expect(readAloudMode({ ...p, isPrivate: false, ttsTrusted: false })).toBe('server');
		expect(readAloudMode({ ...p, isPrivate: false, ttsConfigured: false })).toBe('browser');
		expect(
			readAloudMode({ ...p, isPrivate: false, ttsConfigured: false, browserVoice: false })
		).toBe('hidden');
	});
});
