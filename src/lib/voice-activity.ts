/** What a level reading changed: speech began, it ended, or a short noise faded out. */
export type VoiceActivityEvent = 'start' | 'end' | 'blip' | null;

export type VoiceActivityOptions = {
	/** Loudness above the noise floor (as a multiple) that counts as speech. */
	ratio: number;
	/** Quietest RMS level that can count as speech, however quiet the room. */
	minLevel: number;
	/** How long it must stay loud before speech starts. */
	startMs: number;
	/** How long a pause must last before the speaker is done. */
	endMs: number;
	/** Speech shorter than this (a cough, a click) is a blip, not a turn. */
	minSpeechMs: number;
};

/** How long the detector listens to the room before it can hear speech. */
const CALIBRATION_MS = 400;
/** How quickly the smoothed level follows the readings. */
const SMOOTHING_MS = 80;
/** A pause is quieter than this share of the turn's loudest speech. */
const PAUSE_RATIO = 0.25;
/** How long the turn's loudest moment keeps counting (it slowly fades). */
const PEAK_MEMORY_MS = 4000;

export const TURN_DETECTION: VoiceActivityOptions = {
	ratio: 3,
	minLevel: 0.012,
	startMs: 120,
	// Short: a pause only starts transcription; the turn is sent once it sounds finished.
	endMs: 700,
	minSpeechMs: 350
};

/** Stricter: the assistant's own voice leaks into the microphone while it talks. */
export const BARGE_IN_DETECTION: VoiceActivityOptions = {
	ratio: 4,
	minLevel: 0.03,
	startMs: 300,
	endMs: 600,
	minSpeechMs: 0
};

/**
 * Energy-based voice activity detection: tells speech from the room's noise
 * floor, which it keeps learning, and when a speaker has finished talking.
 */
export class VoiceActivity {
	#options: VoiceActivityOptions;
	#floor = 0.004;
	#loudFor = 0;
	#quietFor = 0;
	#voicedFor = 0;
	/** The level smoothed over a few readings, so single frames don't decide. */
	#smoothed = 0;
	/** How loud this turn's speech has been (slowly forgetting), to judge its pauses by. */
	#peak = 0;
	/** Time left to learn the room's noise before any speech can start. */
	#calibrating = CALIBRATION_MS;
	speaking = false;

	constructor(options: VoiceActivityOptions) {
		this.#options = options;
	}

	get threshold(): number {
		return Math.max(this.#options.minLevel, this.#floor * this.#options.ratio);
	}

	/** Feeds one RMS level reading (0–1) covering the last `dt` ms. */
	update(level: number, dt: number): VoiceActivityEvent {
		const { startMs, endMs, minSpeechMs } = this.#options;
		this.#smoothed += (level - this.#smoothed) * Math.min(1, dt / SMOOTHING_MS);
		if (this.#calibrating > 0) {
			this.#calibrating -= dt;
			this.#learn(level, 150, dt);
			return null;
		}
		const threshold = this.threshold;
		if (!this.speaking) {
			if (level > threshold) {
				this.#loudFor += dt;
				// Constant noise (a fan) slowly raises the floor instead of counting as speech forever.
				this.#learn(level, 8000, dt);
				if (this.#loudFor >= startMs) {
					this.speaking = true;
					this.#quietFor = 0;
					this.#voicedFor = this.#loudFor;
					this.#peak = this.#smoothed;
					return 'start';
				}
			} else {
				this.#loudFor = Math.max(0, this.#loudFor - dt);
				this.#learn(level, 1500, dt);
			}
			return null;
		}
		this.#peak = Math.max(this.#smoothed, this.#peak * Math.exp(-dt / PEAK_MEMORY_MS));
		// A pause is quiet next to the speech itself, not just next to the room
		// before it: auto gain often turns the room up once the speaker stops.
		// Hysteresis keeps trailing-off syllables counting as speech.
		const quiet = Math.max(threshold * 0.6, this.#peak * PAUSE_RATIO);
		if (this.#smoothed > quiet) {
			this.#quietFor = 0;
			this.#voicedFor += dt;
		} else {
			this.#quietFor += dt;
			// The pause tells what the room sounds like now.
			this.#learn(level, 1500, dt);
		}
		if (this.#quietFor < endMs) return null;
		const voiced = this.#voicedFor;
		this.reset();
		return voiced >= minSpeechMs ? 'end' : 'blip';
	}

	/** Forgets the current speech, keeping the learned noise floor. */
	reset() {
		this.speaking = false;
		this.#loudFor = 0;
		this.#quietFor = 0;
		this.#voicedFor = 0;
		this.#peak = 0;
	}

	#learn(level: number, tau: number, dt: number) {
		this.#floor = Math.max(0.001, this.#floor + (level - this.#floor) * Math.min(1, dt / tau));
	}
}

/** Root mean square of a block of samples (-1 to 1). */
export function rms(samples: Float32Array): number {
	let sum = 0;
	for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
	return samples.length ? Math.sqrt(sum / samples.length) : 0;
}

/** Words a speaker who is still going tends to pause on. */
const CONTINUATIONS = new Set(
	'and or but so because cause then if when while like um uh erm hmm the a an to of for with about from in on at my your our their is are was were'.split(
		' '
	)
);

/**
 * Whether a transcript sounds like a finished thought: it ends in a full stop,
 * question or exclamation mark (not a trailing "…") and not on a word people
 * pause on mid-sentence ("and", "um", "the"). Speech to text punctuates, so
 * this is a cheap signal that the turn can be sent without waiting longer.
 */
export function soundsFinished(text: string): boolean {
	const trimmed = text.trim().replace(/["'”’)\]]+$/, '');
	if (!/[.?!]$/.test(trimmed) || /(\.\.\.|…)$/.test(trimmed)) return false;
	const last = trimmed
		.replace(/[.?!]+$/, '')
		.split(/\s+/)
		.at(-1)
		?.toLowerCase()
		.replace(/[^\p{L}']/gu, '');
	return !!last && !CONTINUATIONS.has(last);
}
