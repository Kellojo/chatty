// Notification sounds, synthesised with Web Audio so there are no asset files.
// Browsers only allow audio after a user gesture, so the context is created (or
// resumed) on the first pointer/key press via `unlockAudioOnGesture`.
//
// Each tone is a few "strikes"; a strike is a set of sine partials, each with its
// own level and decay, like a struck object (higher partials die out first).
// Everything runs through one output chain: a soft low-pass, a short generated
// room reverb and a limiter, so tones sound round instead of beepy and never clip.

export const SOUND_TONES = ['chime', 'pop', 'bell'] as const;
export type SoundTone = (typeof SOUND_TONES)[number];

export const SOUND_TONE_LABEL: Record<SoundTone, string> = {
	chime: 'Chime',
	pop: 'Pop',
	bell: 'Bell'
};

interface Overtone {
	/** Frequency as a multiple of the strike's base frequency. */
	ratio: number;
	/** Relative level. */
	gain: number;
	/** Seconds until the partial has faded out. */
	decay: number;
	/** Fixed offset in Hz; slightly detuned twins make a bell shimmer. */
	detuneHz?: number;
	/** Stereo position, -1 (left) to 1 (right). */
	pan?: number;
}

/** A burst of band-passed noise: the metallic "tick" of a hammer hitting metal. */
interface Click {
	/** Centre frequency of the band in Hz. */
	freq: number;
	q: number;
	/** Level relative to the strike. */
	gain: number;
	/** Seconds. */
	duration: number;
}

interface Strike {
	freq: number;
	/** Start offset in seconds. */
	at: number;
	/** Attack time in seconds; a few ms avoids clicks without sounding soft. */
	attack: number;
	partials: Overtone[];
	/** Glide the pitch down to this multiple of `freq` (a "bloop"). */
	glideTo?: { ratio: number; time: number };
	click?: Click;
	/** Overall level of this strike, 0..1. */
	level: number;
}

interface ToneSpec {
	strikes: Strike[];
	/** Reverb send, 0..1. */
	wet: number;
}

/** Glassy mallet: a strong fundamental with a quiet, quickly fading overtone set. */
const MALLET: Overtone[] = [
	{ ratio: 1, gain: 1, decay: 1.1 },
	{ ratio: 2, gain: 0.16, decay: 0.45 },
	{ ratio: 3, gain: 0.05, decay: 0.22 },
	{ ratio: 4.16, gain: 0.03, decay: 0.12 }
];

/**
 * Bright handbell. Tuned like a real handbell (fundamental plus the 12th, three
 * times the pitch) with a few inharmonic metal partials up top that die quickly.
 * The fundamental gets a long tail, and slightly detuned twins panned left and
 * right make it shimmer and sound wide.
 */
const BELL: Overtone[] = [
	{ ratio: 1, gain: 1, decay: 3.2 },
	{ ratio: 1, gain: 0.45, decay: 2.8, detuneHz: 2.2, pan: -0.5 },
	{ ratio: 1, gain: 0.45, decay: 2.6, detuneHz: -1.7, pan: 0.5 },
	{ ratio: 2, gain: 0.2, decay: 1.4 },
	{ ratio: 3, gain: 0.42, decay: 1.6 },
	{ ratio: 3, gain: 0.16, decay: 1.3, detuneHz: 3.1, pan: 0.4 },
	{ ratio: 4.18, gain: 0.12, decay: 0.55, pan: -0.3 },
	{ ratio: 5.43, gain: 0.08, decay: 0.32, pan: 0.3 },
	{ ratio: 6.79, gain: 0.05, decay: 0.18 }
];

const TONES: Record<SoundTone, ToneSpec> = {
	// Two-note rising fifth, D5 -> A5.
	chime: {
		wet: 0.22,
		strikes: [
			{ freq: 587.33, at: 0, attack: 0.004, level: 0.8, partials: MALLET },
			{ freq: 880, at: 0.12, attack: 0.004, level: 0.9, partials: MALLET }
		]
	},
	// Short water-drop: a sine that glides down quickly.
	pop: {
		wet: 0.12,
		strikes: [
			{
				freq: 880,
				at: 0,
				attack: 0.003,
				level: 0.9,
				glideTo: { ratio: 0.42, time: 0.07 },
				partials: [
					{ ratio: 1, gain: 1, decay: 0.16 },
					{ ratio: 2, gain: 0.08, decay: 0.06 }
				]
			}
		]
	},
	// One struck handbell at C6.
	bell: {
		wet: 0.35,
		strikes: [
			{
				freq: 1046.5,
				at: 0,
				attack: 0.0015,
				level: 0.8,
				partials: BELL,
				click: { freq: 5200, q: 1.2, gain: 0.35, duration: 0.025 }
			}
		]
	}
};

interface Output {
	ctx: AudioContext;
	/** Dry input of the chain. */
	dry: AudioNode;
	/** Reverb send of the chain. */
	wet: AudioNode;
	/** Half a second of white noise for strike clicks. */
	noise: AudioBuffer;
}

let output: Output | null = null;

/** A short, diffuse room: decaying stereo noise used as a convolution impulse. */
function roomImpulse(ctx: AudioContext, seconds = 1.4): AudioBuffer {
	const length = Math.floor(ctx.sampleRate * seconds);
	const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
	for (let channel = 0; channel < 2; channel++) {
		const data = buffer.getChannelData(channel);
		for (let i = 0; i < length; i++) {
			data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 3);
		}
	}
	return buffer;
}

function getOutput(): Output | null {
	if (output) return output;
	if (typeof AudioContext === 'undefined') return null;
	let ctx: AudioContext;
	try {
		ctx = new AudioContext();
	} catch {
		return null;
	}

	const limiter = ctx.createDynamicsCompressor();
	limiter.threshold.value = -10;
	limiter.knee.value = 6;
	limiter.ratio.value = 12;
	limiter.attack.value = 0.002;
	limiter.release.value = 0.15;
	limiter.connect(ctx.destination);

	// Takes the digital edge off the upper partials.
	const tone = ctx.createBiquadFilter();
	tone.type = 'lowpass';
	tone.frequency.value = 7500;
	tone.Q.value = 0.5;
	tone.connect(limiter);

	const reverb = ctx.createConvolver();
	reverb.buffer = roomImpulse(ctx);
	reverb.connect(tone);

	const noise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.5), ctx.sampleRate);
	const samples = noise.getChannelData(0);
	for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;

	output = { ctx, dry: tone, wet: reverb, noise };
	return output;
}

/** Prepares audio on the first user gesture; returns a cleanup. */
export function unlockAudioOnGesture(): () => void {
	const unlock = () => {
		const ctx = getOutput()?.ctx;
		if (ctx?.state === 'suspended') void ctx.resume().catch(() => undefined);
		remove();
	};
	const remove = () => {
		window.removeEventListener('pointerdown', unlock, true);
		window.removeEventListener('keydown', unlock, true);
	};
	window.addEventListener('pointerdown', unlock, true);
	window.addEventListener('keydown', unlock, true);
	return remove;
}

function playStrike(out: Output, strike: Strike, start: number, send: GainNode, dry: GainNode) {
	const { ctx } = out;
	const t = start + strike.at;
	const total = strike.partials.reduce((sum, p) => sum + p.gain, 0);
	for (const partial of strike.partials) {
		const osc = ctx.createOscillator();
		osc.type = 'sine';
		const freq = strike.freq * partial.ratio + (partial.detuneHz ?? 0);
		osc.frequency.setValueAtTime(freq, t);
		if (strike.glideTo) {
			osc.frequency.exponentialRampToValueAtTime(
				freq * strike.glideTo.ratio,
				t + strike.glideTo.time
			);
		}

		// Normalise so a rich spectrum isn't louder than a simple one.
		const peak = (partial.gain / total) * strike.level;
		const env = ctx.createGain();
		env.gain.setValueAtTime(0, t);
		env.gain.linearRampToValueAtTime(peak, t + strike.attack);
		env.gain.exponentialRampToValueAtTime(0.0001, t + strike.attack + partial.decay);

		osc.connect(env);
		let last: AudioNode = env;
		if (partial.pan) {
			const panner = ctx.createStereoPanner();
			panner.pan.value = partial.pan;
			env.connect(panner);
			last = panner;
		}
		last.connect(dry);
		last.connect(send);
		osc.start(t);
		osc.stop(t + strike.attack + partial.decay + 0.05);
	}
	if (strike.click) playClick(out, strike.click, t, strike.level, send, dry);
}

function playClick(
	out: Output,
	click: Click,
	t: number,
	level: number,
	send: GainNode,
	dry: GainNode
) {
	const { ctx } = out;
	const source = ctx.createBufferSource();
	source.buffer = out.noise;
	const band = ctx.createBiquadFilter();
	band.type = 'bandpass';
	band.frequency.value = click.freq;
	band.Q.value = click.q;
	const env = ctx.createGain();
	env.gain.setValueAtTime(click.gain * level, t);
	env.gain.exponentialRampToValueAtTime(0.0001, t + click.duration);
	source.connect(band).connect(env);
	env.connect(dry);
	env.connect(send);
	source.start(t);
	source.stop(t + click.duration + 0.02);
}

export function playTone(tone: SoundTone, volume: number): void {
	const out = getOutput();
	if (!out || volume <= 0) return;
	const { ctx } = out;
	if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);

	const spec = TONES[tone];
	// Squared so the slider feels even: loudness is roughly logarithmic.
	const level = Math.min(1, volume) ** 2 * 0.9;
	const dry = ctx.createGain();
	dry.gain.value = level;
	dry.connect(out.dry);
	const send = ctx.createGain();
	send.gain.value = level * spec.wet;
	send.connect(out.wet);

	const start = ctx.currentTime + 0.01;
	for (const strike of spec.strikes) playStrike(out, strike, start, send, dry);

	// Drop the per-play buses once every partial and the reverb tail are done.
	const end = Math.max(
		...spec.strikes.map((s) => s.at + s.attack + Math.max(...s.partials.map((p) => p.decay)))
	);
	setTimeout(
		() => {
			dry.disconnect();
			send.disconnect();
		},
		(end + 1.6) * 1000
	);
}
