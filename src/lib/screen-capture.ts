// "Attach a screenshot": the browser's screen picker (a screen, window or tab),
// one frame of it as a PNG, then the capture stops right away.

export function canCaptureScreen(): boolean {
	return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia;
}

/**
 * Asks for a screen, window or tab and returns one frame of it as a PNG file,
 * or null when the user cancels the picker.
 */
export async function captureScreen(now = Date.now()): Promise<File | null> {
	let stream: MediaStream;
	try {
		stream = await navigator.mediaDevices.getDisplayMedia({
			video: true,
			audio: false,
			// Chromium hints: Chatty itself is rarely what you want to show it.
			selfBrowserSurface: 'exclude',
			surfaceSwitching: 'exclude',
			monitorTypeSurfaces: 'include'
		} as DisplayMediaStreamOptions);
	} catch (e) {
		// Dismissing the picker rejects with NotAllowedError: not an error to report.
		if (e instanceof DOMException && e.name === 'NotAllowedError') return null;
		throw e;
	}
	try {
		const video = document.createElement('video');
		video.muted = true;
		video.playsInline = true;
		video.srcObject = stream;
		await video.play();
		// The first frames can still be blank while the capture spins up.
		await nextFrame(video);
		await nextFrame(video);
		const canvas = document.createElement('canvas');
		canvas.width = video.videoWidth;
		canvas.height = video.videoHeight;
		const context = canvas.getContext('2d');
		if (!context || canvas.width === 0) throw new Error('Could not capture the screen');
		context.drawImage(video, 0, 0);
		const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
		if (!blob) throw new Error('Could not capture the screen');
		const stamp = new Date(now).toISOString().slice(0, 19).replace(/[T:]/g, '-');
		return new File([blob], `screenshot-${stamp}.png`, { type: 'image/png', lastModified: now });
	} finally {
		for (const track of stream.getTracks()) track.stop();
	}
}

function nextFrame(video: HTMLVideoElement): Promise<void> {
	return new Promise((resolve) => {
		if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(() => resolve());
		else requestAnimationFrame(() => resolve());
	});
}
