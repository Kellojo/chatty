// Pixel position of a caret inside a <textarea>, via an off-screen mirror element
// that copies the textarea's text layout.

const COPIED = [
	'boxSizing',
	'width',
	'overflowX',
	'overflowY',
	'borderTopWidth',
	'borderRightWidth',
	'borderBottomWidth',
	'borderLeftWidth',
	'paddingTop',
	'paddingRight',
	'paddingBottom',
	'paddingLeft',
	'fontStyle',
	'fontVariant',
	'fontWeight',
	'fontStretch',
	'fontSize',
	'lineHeight',
	'fontFamily',
	'textAlign',
	'textTransform',
	'textIndent',
	'letterSpacing',
	'wordSpacing',
	'tabSize'
] as const;

/** Caret position relative to the textarea's top-left corner, accounting for its scroll. */
export function caretCoordinates(
	textarea: HTMLTextAreaElement,
	position: number
): { top: number; left: number; height: number } {
	const style = getComputedStyle(textarea);
	const mirror = document.createElement('div');
	const s = mirror.style;
	for (const prop of COPIED) s[prop] = style[prop];
	s.position = 'absolute';
	s.visibility = 'hidden';
	s.whiteSpace = 'pre-wrap';
	s.overflowWrap = 'break-word';
	s.top = '0';
	s.left = '-9999px';
	mirror.textContent = textarea.value.slice(0, position);
	const marker = document.createElement('span');
	marker.textContent = textarea.value.slice(position) || '.';
	mirror.appendChild(marker);
	document.body.appendChild(mirror);
	const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5;
	const coords = {
		top: marker.offsetTop + parseFloat(style.borderTopWidth) - textarea.scrollTop,
		left: marker.offsetLeft + parseFloat(style.borderLeftWidth) - textarea.scrollLeft,
		height: lineHeight
	};
	mirror.remove();
	return coords;
}
