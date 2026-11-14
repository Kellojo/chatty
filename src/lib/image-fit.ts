/** A rotation in degrees, folded into [0, 360). Accepts any multiple of 90, negative included. */
export function normalizeRotation(deg: number): number {
	return ((deg % 360) + 360) % 360;
}

/** True when the image is turned on its side, swapping its visual width and height. */
export function isSideways(deg: number): boolean {
	return normalizeRotation(deg) % 180 !== 0;
}

export type RotatedFit = {
	/** Size to give the (unrotated) `<img>` element. */
	width: number;
	height: number;
	/** Size of the box the rotated image visually occupies. */
	boxWidth: number;
	boxHeight: number;
};

/**
 * Scales an image of natural size `w`×`h` so that, once rotated by `rotation`
 * degrees, it fits within `maxW`×`maxH`. CSS transforms don't affect layout, so
 * the caller sizes a box with `boxWidth`×`boxHeight` and centers the `<img>`
 * (sized `width`×`height`) inside it before rotating.
 */
export function fitRotated(
	w: number,
	h: number,
	maxW: number,
	maxH: number,
	rotation: number,
	{ upscale = false }: { upscale?: boolean } = {}
): RotatedFit {
	const sideways = isSideways(rotation);
	const visualW = sideways ? h : w;
	const visualH = sideways ? w : h;
	let scale = Math.min(maxW / visualW, maxH / visualH);
	if (!upscale) scale = Math.min(scale, 1);
	if (!Number.isFinite(scale) || scale <= 0) scale = 0;
	return {
		width: w * scale,
		height: h * scale,
		boxWidth: visualW * scale,
		boxHeight: visualH * scale
	};
}
