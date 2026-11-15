import { afterEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { createVoiceListener } from './voice-listener.svelte.js';
import { unlockVoiceAudio } from './voice-audio.js';

/** Audio only runs after a user gesture: click a button that unlocks it, like the voice button. */
async function clickToUnlock(...contexts: AudioContext[]) {
	const button = document.createElement('button');
	button.textContent = 'Start voice mode';
	button.onclick = () => {
		unlockVoiceAudio();
		for (const ctx of contexts) void ctx.resume();
	};
	document.body.append(button);
	await userEvent.click(button);
	button.remove();
}

/**
 * A fake microphone: quiet room noise, then a "voice" (a loud tone) for
 * `speakMs`, then the room again. Runs in its own AudioContext like a real mic.
 */
function fakeMicrophone(...speech: [atMs: number, forMs: number][]) {
	const ctx = new AudioContext();
	const tone = ctx.createOscillator();
	tone.frequency.value = 220;
	const gain = ctx.createGain();
	gain.gain.value = 0.003;
	const out = ctx.createMediaStreamDestination();
	tone.connect(gain).connect(out);
	tone.start();
	/** Starts the scripted speech, timed from now (call once listening has begun). */
	function speak() {
		const t0 = ctx.currentTime;
		for (const [at, ms] of speech) {
			gain.gain.setValueAtTime(0.2, t0 + at / 1000);
			gain.gain.setValueAtTime(0.003, t0 + (at + ms) / 1000);
		}
	}
	return { stream: out.stream, ctx, speak };
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('createVoiceListener (server speech to text)', () => {
	it('hears a turn start and end, and transcribes it', async () => {
		const mic = fakeMicrophone([800, 1500]);
		await clickToUnlock(mic.ctx);
		vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockResolvedValue(mic.stream);
		const fetchMock = vi.fn(async () => Response.json({ text: 'hello there' }));
		vi.stubGlobal('fetch', fetchMock);

		const turns: string[] = [];
		const errors: string[] = [];
		const listener = createVoiceListener({
			sttModel: { providerId: 'p', modelId: 'm' },
			onturn: (text) => turns.push(text),
			onbargein: () => {},
			onerror: (m) => errors.push(m),
			onfatal: () => {}
		});
		expect(await listener.open()).toBe(true);
		listener.listen();
		mic.speak();

		let sawHearing = false;
		const deadline = performance.now() + 12_000;
		while (turns.length === 0 && performance.now() < deadline) {
			if (listener.hearing) sawHearing = true;
			await new Promise((r) => setTimeout(r, 50));
		}
		listener.close();
		await mic.ctx.close();

		expect(errors).toEqual([]);
		expect(sawHearing).toBe(true);
		expect(turns).toEqual(['hello there']);
		expect(fetchMock).toHaveBeenCalledOnce();
	}, 20_000);

	it('keeps a short pause within one turn: both parts are sent together', async () => {
		// Talk, pause ~1.1s (long enough to look like the end), then go on.
		const mic = fakeMicrophone([800, 1200], [3100, 1200]);
		await clickToUnlock(mic.ctx);
		vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockResolvedValue(mic.stream);
		const replies = ['Plan a trip', 'to the coast'];
		const fetchMock = vi.fn(async () => Response.json({ text: replies.shift() ?? '' }));
		vi.stubGlobal('fetch', fetchMock);

		const turns: string[] = [];
		const listener = createVoiceListener({
			sttModel: { providerId: 'p', modelId: 'm' },
			onturn: (text) => turns.push(text),
			onbargein: () => {},
			onerror: () => {},
			onfatal: () => {}
		});
		expect(await listener.open()).toBe(true);
		listener.listen();
		mic.speak();

		const deadline = performance.now() + 15_000;
		while (turns.length === 0 && performance.now() < deadline) {
			await new Promise((r) => setTimeout(r, 50));
		}
		// Nothing else arrives afterwards as a second turn.
		await new Promise((r) => setTimeout(r, 300));
		listener.close();
		await mic.ctx.close();

		expect(turns).toEqual(['Plan a trip to the coast']);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	}, 20_000);

	it('sends at once when what was said sounds finished', async () => {
		// Same timing as above, but the first part is a finished sentence.
		const mic = fakeMicrophone([800, 1200], [3100, 1200]);
		await clickToUnlock(mic.ctx);
		vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockResolvedValue(mic.stream);
		const fetchMock = vi.fn(async () => Response.json({ text: 'Book a table for two.' }));
		vi.stubGlobal('fetch', fetchMock);

		const turns: string[] = [];
		const listener = createVoiceListener({
			sttModel: { providerId: 'p', modelId: 'm' },
			onturn: (text) => turns.push(text),
			onbargein: () => {},
			onerror: () => {},
			onfatal: () => {}
		});
		expect(await listener.open()).toBe(true);
		listener.listen();
		mic.speak();

		const deadline = performance.now() + 15_000;
		while (turns.length === 0 && performance.now() < deadline) {
			await new Promise((r) => setTimeout(r, 50));
		}
		await new Promise((r) => setTimeout(r, 300));
		listener.close();
		await mic.ctx.close();

		// Sent before the speech resumed: one turn, the second part not merged in.
		expect(turns).toEqual(['Book a table for two.']);
		expect(fetchMock).toHaveBeenCalledOnce();
	}, 20_000);

	it('takes the send back when the user talks again while it is being sent', async () => {
		// Talk, pause long enough for the turn to be sent (~1.7s), then go on while
		// the (slow) transcription is still running: one turn with both parts.
		const mic = fakeMicrophone([800, 1200], [3700, 1200]);
		await clickToUnlock(mic.ctx);
		vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockResolvedValue(mic.stream);
		const replies = ['Plan a trip', 'to the coast'];
		const fetchMock = vi.fn(async () => {
			const text = replies.shift() ?? '';
			await new Promise((r) => setTimeout(r, 1500));
			return Response.json({ text });
		});
		vi.stubGlobal('fetch', fetchMock);

		const turns: string[] = [];
		let sawCommitting = false;
		const listener = createVoiceListener({
			sttModel: { providerId: 'p', modelId: 'm' },
			onturn: (text) => turns.push(text),
			onbargein: () => {},
			onerror: () => {},
			onfatal: () => {}
		});
		expect(await listener.open()).toBe(true);
		listener.listen();
		mic.speak();

		const deadline = performance.now() + 18_000;
		while (turns.length === 0 && performance.now() < deadline) {
			if (listener.transcribing) sawCommitting = true;
			await new Promise((r) => setTimeout(r, 50));
		}
		await new Promise((r) => setTimeout(r, 300));
		listener.close();
		await mic.ctx.close();

		expect(sawCommitting).toBe(true);
		expect(turns).toEqual(['Plan a trip to the coast']);
	}, 25_000);
});
