// Rasterizes Chatty's mark (the `>_` prompt tile from src/lib/assets/favicon.svg
// and the sign-in header) into the PWA and home-screen PNG icons in static/.
// Run: node scripts/generate-pwa-icons.mjs
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const out = (name) => fileURLToPath(new URL(`../static/${name}`, import.meta.url));

// The light theme's mark: a --foreground tile with a --background glyph
// (src/routes/layout.css, oklch(0.26 0.004 60) and oklch(0.98 0.002 60)).
const TILE = '#252422';
const GLYPH = '#f9f8f7';

// The glyph in a 24-unit box, as drawn in favicon.svg.
const GLYPH_PATHS = `
	<path d="M5.5 6.5l5 5.5-5 5.5"/>
	<path d="M12.5 18h6"/>`;

/**
 * One icon as SVG, drawn on a 512-unit canvas.
 * - `bleed`: fill the whole square (maskable / Apple), the platform masks it;
 *   otherwise a rounded tile like the in-app mark.
 * - `glyph`: the glyph's 24-unit box as a share of the canvas.
 * - `stroke`: the glyph's stroke in 24-unit box units (2.4 in the app); small
 *   renders get a heavier one so the underscore doesn't shrink to a dot.
 */
function iconSvg({ bleed, glyph, stroke = 2.4 }) {
	const S = 512;
	// A pre-rounded tile keeps a small transparent margin, like other app icons.
	const inset = bleed ? 0 : S * 0.04;
	const T = S - 2 * inset;
	const radius = bleed ? 0 : T * (5.5 / 24);
	const box = T * glyph;
	const scale = box / 24;
	// The glyph's ink spans x 5.5–18.5 and y 6.5–18; centre that, not the box.
	const tx = S / 2 - 12 * scale;
	const ty = S / 2 - 12.25 * scale;
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}">
	<defs>
		<radialGradient id="lift" cx="50%" cy="0%" r="85%" fx="50%" fy="0%">
			<stop offset="0" stop-color="${GLYPH}" stop-opacity="0.15"/>
			<stop offset="1" stop-color="${GLYPH}" stop-opacity="0"/>
		</radialGradient>
	</defs>
	<rect x="${inset}" y="${inset}" width="${T}" height="${T}" rx="${radius}" fill="${TILE}"/>
	<rect x="${inset}" y="${inset}" width="${T}" height="${T}" rx="${radius}" fill="url(#lift)"/>
	${bleed ? '' : `<rect x="${inset + 1.5}" y="${inset + 1.5}" width="${T - 3}" height="${T - 3}" rx="${radius - 1.5}" fill="none" stroke="#ffffff" stroke-opacity="0.08" stroke-width="3"/>`}
	<g transform="translate(${tx} ${ty}) scale(${scale})" fill="none" stroke="${GLYPH}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">${GLYPH_PATHS}
	</g>
</svg>`;
}

async function render(svg, size, name, { opaque = false } = {}) {
	let img = sharp(Buffer.from(svg), { density: 72 * (size / 512) * 4 }).resize(size, size);
	// Full-bleed icons carry no alpha: platforms that don't mask fill it with black.
	if (opaque) img = img.flatten({ background: TILE });
	await img.png().toFile(out(name));
}

// "any" icons: the rounded tile, glyph slightly larger than in the app. The 192
// one also stands in at favicon sizes, so its glyph is bigger and bolder.
await render(iconSvg({ bleed: false, glyph: 0.86, stroke: 2.7 }), 192, 'pwa-192x192.png');
await render(iconSvg({ bleed: false, glyph: 0.78 }), 512, 'pwa-512x512.png');

// Maskable: full bleed; the glyph stays inside the 80% safe circle.
await render(iconSvg({ bleed: true, glyph: 0.74 }), 512, 'pwa-maskable-512x512.png', {
	opaque: true
});

// iOS rounds the corners itself and shows transparency as black.
await render(iconSvg({ bleed: true, glyph: 0.74 }), 180, 'apple-touch-icon.png', { opaque: true });

console.log(
	'Wrote static/pwa-192x192.png, static/pwa-512x512.png, static/pwa-maskable-512x512.png, static/apple-touch-icon.png'
);
