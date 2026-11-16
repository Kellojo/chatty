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
		expect(voiceModeAvailable({ ...base, isPrivate: true })).toBe(false);
		expect(voiceModeAvailable({ ...base, isPrivate: false })).toBe(true);
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
