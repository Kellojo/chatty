import { browser } from '$app/environment';
import { serverChunks, speakableText, speechChunks } from '$lib/speakable-text.js';

/** Max time to wait for one chunk of server audio. */
const REQUEST_TIMEOUT = 60_000;
/** An empty WAV, played on click to unlock the audio element. */
export const SILENT_WAV =
	'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';

/**
 * Synthesizes `text` with the Text to speech default (or `voice`) and returns
 * an object URL for the audio, which the caller revokes.
 */
export async function fetchSpeech(
	text: string,
	signal: AbortSignal,
	voice?: string
): Promise<string> {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT);
	const res = await fetch('/api/speech/synthesize', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(voice ? { text, voice } : { text }),
		signal: AbortSignal.any([signal, timeout])
	}).catch((e: unknown) => {
		throw timeout.aborted ? new Error('Speech timed out') : e;
	});
	if (!res.ok) {
		const payload = (await res.json().catch(() => null)) as { message?: string } | null;
		throw new Error(payload?.message ?? `Speech failed (${res.status})`);
	}
	return URL.createObjectURL(await res.blob());
}

export type SpeechPlayback = ReturnType<typeof createSpeechPlayback>;

/**
 * Reads messages aloud, one at a time. While `serverTts()` is true the Text to
 * speech default synthesizes the audio, sentence chunks fetched one ahead of
 * playback; otherwise the browser's built-in voice is used. `onerror` reports
 * failures (e.g. as a toast).
 */
export function createSpeechPlayback(options: {
	serverTts: () => boolean;
	onerror?: (message: string) => void;
	/** Non-error notes, e.g. that only the start of a very long reply is read. */
	oninfo?: (message: string) => void;
	/** Playback volume, 0 to 1; read as each chunk starts. */
	volume?: () => number;
}) {
	const volume = () => Math.min(1, Math.max(0, options.volume?.() ?? 1));
	/** The message being read aloud (or fetched), else null. */
	let activeId = $state<string | null>(null);
	/** True while waiting on server audio before (or between) chunks. */
	let loading = $state(false);

	const browserVoice =
		browser && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;

	/** How the current playback runs, so stop() undoes the right one. */
	let mode: 'server' | 'browser' | null = null;
	/**
	 * Two elements take turns: one plays while the next chunk loads into the other,
	 * so chunks follow each other without a gap. Both are created and unlocked during
	 * the click, as Safari refuses play() on a new element once the gesture has passed.
	 */
	let players: [HTMLAudioElement, HTMLAudioElement] | null = null;
	let controller: AbortController | null = null;
	const objectUrls: string[] = [];
	/** Bumped on every start/stop so late callbacks from an old playback are ignored. */
	let generation = 0;
	/** The voice the current playback asked for; unset reads with the configured default. */
	let voiceOverride: string | undefined;

	function cleanup() {
		controller?.abort();
		controller = null;
		for (const el of players ?? []) {
			el.onended = null;
			el.onerror = null;
			el.onplaying = null;
			el.pause();
		}
		for (const url of objectUrls.splice(0)) URL.revokeObjectURL(url);
		if (mode === 'browser') window.speechSynthesis.cancel();
		mode = null;
	}

	function stop() {
		generation++;
		cleanup();
		activeId = null;
		loading = false;
	}

	function fail(gen: number, message: string) {
		if (gen !== generation) return;
		stop();
		options.onerror?.(message);
	}

	/**
	 * Fetches one chunk's audio in full. Playback waits for the whole first chunk,
	 * which is why it is kept short (see serverChunks).
	 */
	async function fetchChunk(text: string, signal: AbortSignal): Promise<string> {
		const url = await fetchSpeech(text, signal, voiceOverride);
		objectUrls.push(url);
		return url;
	}

	/** Loads `url` into `el` ahead of playing it. */
	function prepare(el: HTMLAudioElement, url: string) {
		el.preload = 'auto';
		el.src = url;
		el.load();
	}

	/** Plays what `el` has loaded to its end, or until `signal` aborts; rejects if it can't play. */
	function playLoaded(el: HTMLAudioElement, gen: number, signal: AbortSignal): Promise<void> {
		return new Promise((resolve, reject) => {
			if (gen !== generation || signal.aborted) return resolve();
			signal.addEventListener('abort', () => resolve(), { once: true });
			el.onplaying = () => {
				if (gen === generation) loading = false;
			};
			el.onended = () => resolve();
			el.onerror = () => reject(new Error('Could not play the audio'));
			el.volume = volume();
			el.play().catch((e: unknown) => {
				reject(
					e instanceof DOMException && e.name === 'NotAllowedError'
						? new Error('Your browser blocked playback. Tap read aloud again.')
						: e
				);
			});
		});
	}

	async function playServer(
		els: [HTMLAudioElement, HTMLAudioElement],
		chunks: string[],
		gen: number
	) {
		controller = new AbortController();
		const { signal } = controller;
		loading = true;
		/** Fetches chunk `i` into its element; `ready` says whether it has arrived. */
		const load = (i: number) => {
			const job = {
				ready: false,
				url: fetchChunk(chunks[i], signal).then((url) => {
					if (gen === generation) prepare(els[i % 2], url);
					job.ready = true;
					return url;
				})
			};
			job.url.catch(() => {}); // handled when awaited
			return job;
		};
		try {
			let next = load(0);
			for (let i = 0; i < chunks.length; i++) {
				const url = await next.url;
				if (gen !== generation) return;
				// Load the next chunk into the other element while this one plays.
				if (i + 1 < chunks.length) next = load(i + 1);
				await playLoaded(els[i % 2], gen, signal);
				if (gen !== generation) return;
				URL.revokeObjectURL(url);
				objectUrls.splice(objectUrls.indexOf(url), 1);
				// Only show the spinner again if the next chunk is still on its way.
				if (i + 1 < chunks.length && !next.ready) loading = true;
			}
			if (gen === generation) stop();
		} catch (e) {
			if (gen !== generation || signal.aborted) return;
			fail(gen, e instanceof Error ? e.message : 'Speech failed');
		}
	}

	function playBrowser(chunks: string[], gen: number) {
		const synth = window.speechSynthesis;
		chunks.forEach((chunk, i) => {
			const utterance = new SpeechSynthesisUtterance(chunk);
			utterance.lang = document.documentElement.lang || navigator.language;
			utterance.volume = volume();
			if (i === chunks.length - 1) {
				utterance.onend = () => {
					if (gen === generation) stop();
				};
			}
			utterance.onerror = (event) => {
				// 'interrupted'/'canceled' come from our own cancel() on stop.
				if (event.error === 'interrupted' || event.error === 'canceled') return;
				fail(gen, 'Your browser could not read this aloud');
			};
			synth.speak(utterance);
		});
	}

	/** Starts reading `markdown` aloud as `id`, or stops if `id` is already playing. */
	function toggle(id: string, markdown: string, voice?: string) {
		if (activeId === id) stop();
		else play(id, markdown, voice);
	}

	/**
	 * Reads `markdown` aloud as `id`, replacing whatever is playing. `voice`
	 * overrides the configured voice, e.g. to preview one.
	 */
	function play(id: string, markdown: string, voice?: string) {
		stop();
		voiceOverride = voice || undefined;
		const server = options.serverTts();
		if (!server && !browserVoice) {
			options.onerror?.('Reading aloud is not available in this browser');
			return;
		}
		const text = speakableText(markdown);
		const chunks = server ? serverChunks(text) : speechChunks(text);
		if (chunks.length === 0) {
			options.onerror?.('Nothing to read aloud');
			return;
		}
		if (speakableText(markdown, Infinity).length > text.length) {
			options.oninfo?.('This reply is long, so only its first part is read aloud');
		}
		const gen = generation;
		activeId = id;
		mode = server ? 'server' : 'browser';
		if (server) {
			players ??= [new Audio(), new Audio()];
			// Unlock both elements while the click still counts as a user gesture.
			for (const el of players) {
				el.src = SILENT_WAV;
				el.play().catch(() => {});
			}
			void playServer(players, chunks, gen);
		} else {
			playBrowser(chunks, gen);
		}
	}

	return {
		get activeId() {
			return activeId;
		},
		get loading() {
			return loading;
		},
		/** Reading aloud is possible: a server voice is set or the browser has one. */
		get supported() {
			return browser && (options.serverTts() || browserVoice);
		},
		toggle,
		play,
		stop
	};
}
