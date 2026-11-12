// File Handling: the installed desktop app is offered in "Open with" for the
// types in the manifest's `file_handlers` (vite.config.ts). Chromium launches it
// at the handler's action URL and hands the files over through
// `window.launchQueue`.

interface LaunchParams {
	readonly files: readonly FileSystemHandle[];
}

interface LaunchQueue {
	setConsumer(consumer: (params: LaunchParams) => void): void;
}

/** Calls `onfiles` with the files the app was launched to open, if any. */
export function onLaunchFiles(onfiles: (files: File[]) => void): void {
	const queue = (window as Window & { launchQueue?: LaunchQueue }).launchQueue;
	queue?.setConsumer(async ({ files: handles }) => {
		const files = await Promise.all(
			handles.filter((h): h is FileSystemFileHandle => h.kind === 'file').map((h) => h.getFile())
		);
		if (files.length > 0) onfiles(files);
	});
}
