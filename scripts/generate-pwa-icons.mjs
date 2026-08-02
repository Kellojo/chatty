// Rasterizes src/lib/assets/favicon.svg into the PWA PNG icons in static/.
// Run: node scripts/generate-pwa-icons.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const svg = readFileSync(new URL('../src/lib/assets/favicon.svg', import.meta.url));
const out = (name) => fileURLToPath(new URL(`../static/${name}`, import.meta.url));

// PNG icons are fixed to the dark-tile variant (stone-900 tile, stone-50 glyph);
// the adaptive light/dark in favicon.svg doesn't rasterize predictably.
const darkTile = Buffer.from(
	`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
		<rect width="24" height="24" rx="5.5" fill="#1c1917"/>
		<g transform="translate(3.5 3.5) scale(0.7083)" fill="none" stroke="#fafaf9" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
			<path d="M5.5 6.5l5 5.5-5 5.5"/>
			<path d="M12.5 18h6"/>
		</g>
	</svg>`
);

async function scaled(size) {
	return sharp(darkTile, { density: 300 }).resize(size, size, { fit: 'contain' }).png().toBuffer();
}

await sharp(await scaled(192)).toFile(out('pwa-192x192.png'));
await sharp(await scaled(512)).toFile(out('pwa-512x512.png'));

// Maskable: logo centered at ~80% size on a solid background (safe zone).
const inner = Math.round(512 * 0.8);
await sharp(await scaled(inner))
	.extend({
		top: Math.floor((512 - inner) / 2),
		bottom: Math.ceil((512 - inner) / 2),
		left: Math.floor((512 - inner) / 2),
		right: Math.ceil((512 - inner) / 2),
		background: '#0a0a0a'
	})
	.png()
	.toFile(out('pwa-maskable-512x512.png'));

console.log(
	'Wrote static/pwa-192x192.png, static/pwa-512x512.png, static/pwa-maskable-512x512.png'
);
