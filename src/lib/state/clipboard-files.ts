/** The parts of a paste event's DataTransfer that clipboardFiles reads. */
export interface ClipboardFileSource {
	types: readonly string[];
	files: ArrayLike<File>;
}

// Screenshots and "Copy image" arrive without a real name.
const GENERIC_NAME = /^image\.(png|jpe?g|gif|webp|bmp)$/i;

/**
 * Files to attach from a paste: files copied in the file manager, screenshots
 * and copied images. Returns nothing when the clipboard also holds plain text:
 * apps like Excel or Word put a picture of the selection next to the text, and
 * then pasting the text is what's meant.
 */
export function clipboardFiles(data: ClipboardFileSource | null, now = Date.now()): File[] {
	if (!data || data.types.includes('text/plain')) return [];
	const files = Array.from(data.files);
	return files.map((file, i) => {
		if (file.name && !GENERIC_NAME.test(file.name)) return file;
		const ext = file.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
		const suffix = files.length > 1 ? `-${i + 1}` : '';
		const stamp = new Date(now).toISOString().slice(0, 19).replace(/[T:]/g, '-');
		return new File([file], `pasted-${stamp}${suffix}.${ext}`, {
			type: file.type,
			lastModified: file.lastModified
		});
	});
}
