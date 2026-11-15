import { describe, expect, it } from 'vitest';
import { rms, soundsFinished, TURN_DETECTION, VoiceActivity } from './voice-activity.js';

const STEP = 30;

/** Feeds `ms` worth of readings at `level`, returning the events that fired. */
function feed(vad: VoiceActivity, level: number, ms: number) {
	const events: string[] = [];
	for (let t = 0; t < ms; t += STEP) {
		const event = vad.update(level, STEP);
		if (event) events.push(event);
	}
	return events;
}

describe('VoiceActivity', () => {
	it('detects a spoken turn and its end after a pause', () => {
		const vad = new VoiceActivity(TURN_DETECTION);
		expect(feed(vad, 0.002, 2000)).toEqual([]);
		expect(feed(vad, 0.1, 1500)).toEqual(['start']);
		expect(feed(vad, 0.002, 500)).toEqual([]);
		expect(feed(vad, 0.002, 1000)).toEqual(['end']);
	});

	it('keeps a short pause within the turn', () => {
		const vad = new VoiceActivity(TURN_DETECTION);
		feed(vad, 0.002, 1000);
		feed(vad, 0.1, 600);
		feed(vad, 0.002, 600);
		expect(feed(vad, 0.1, 600)).toEqual([]);
		expect(vad.speaking).toBe(true);
	});

	it('calls a short noise a blip', () => {
		const vad = new VoiceActivity(TURN_DETECTION);
		feed(vad, 0.002, 1000);
		expect([...feed(vad, 0.1, 200), ...feed(vad, 0.002, 1500)]).toEqual(['start', 'blip']);
	});

	it('hears the end of a turn started before the room was learned', () => {
		const vad = new VoiceActivity(TURN_DETECTION);
		// The microphone delivers silence while it warms up, then the room's noise.
		feed(vad, 0, 400);
		feed(vad, 0.009, 300);
		expect(feed(vad, 0.1, 1500)).toEqual(['start']);
		expect(feed(vad, 0.009, 1500)).toEqual(['end']);
	});

	it('hears the end of a turn when the room gets louder after it (auto gain)', () => {
		const vad = new VoiceActivity(TURN_DETECTION);
		feed(vad, 0.002, 3000);
		expect(feed(vad, 0.08, 2000)).toEqual(['start']);
		expect(feed(vad, 0.015, 1500)).toEqual(['end']);
	});

	it('learns a noisy room instead of hearing speech in it', () => {
		const vad = new VoiceActivity(TURN_DETECTION);
		feed(vad, 0.03, 20_000);
		expect(vad.speaking).toBe(false);
		expect(vad.threshold).toBeGreaterThan(0.03);
	});
});

describe('rms', () => {
	it('measures loudness', () => {
		expect(rms(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5);
		expect(rms(new Float32Array(0))).toBe(0);
	});
});

describe('soundsFinished', () => {
	it('accepts a complete sentence or question', () => {
		expect(soundsFinished('Book a table for two.')).toBe(true);
		expect(soundsFinished('What time is it?')).toBe(true);
		expect(soundsFinished('  "That works!"  ')).toBe(true);
	});

	it('waits when the speaker is likely still going', () => {
		expect(soundsFinished('Plan a trip to the coast')).toBe(false);
		expect(soundsFinished('I want to go and.')).toBe(false);
		expect(soundsFinished('So the thing is, um.')).toBe(false);
		expect(soundsFinished('Let me think...')).toBe(false);
		expect(soundsFinished('Let me think…')).toBe(false);
		expect(soundsFinished('')).toBe(false);
	});
});
