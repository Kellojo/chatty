<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import LocateFixedIcon from '@lucide/svelte/icons/locate-fixed';
	import XIcon from '@lucide/svelte/icons/x';
	import { Button } from '$lib/components/ui/button/index.js';
	import type { MemoryGraph, MemoryGraphNode } from '$lib/memory-types.js';

	let {
		graph,
		selected = null,
		insetTop = 0,
		onselect
	}: {
		graph: MemoryGraph;
		/** Node id (`<scope>:<path>`) of the open memory. */
		selected?: string | null;
		/** Space reserved at the top for an overlaid header, kept clear when fitting. */
		insetTop?: number;
		onselect?: (node: MemoryGraphNode) => void;
	} = $props();

	type SimNode = {
		id: string;
		node: MemoryGraphNode;
		title: string;
		folder: string;
		tags: string[];
		x: number;
		y: number;
		vx: number;
		vy: number;
		r: number;
		degree: number;
		color: number;
		phase: number;
		born: number;
		fixed: boolean;
	};
	type SimEdge = { a: SimNode; b: SimNode; kind: 'link' | 'tag'; phase: number };

	let wrap = $state<HTMLDivElement | null>(null);
	let canvas = $state<HTMLCanvasElement | null>(null);
	let hovered = $state.raw<SimNode | null>(null);
	let tooltip = $state<{ x: number; y: number } | null>(null);
	let autoFit = $state(true);
	let legendHeight = $state(0);
	let tooltipHeight = $state(0);
	let tooltipWidth = $state(0);
	// Which side of the cursor the tooltip sits on: away from the node's neighbours.
	let tooltipSide = $state({ left: false, up: false });
	const tooltipLeft = $derived.by(() => {
		if (!tooltip) return 0;
		const x = tooltipSide.left ? tooltip.x - 16 - tooltipWidth : tooltip.x + 16;
		return Math.min(Math.max(x, 8), width - tooltipWidth - 8);
	});
	const tooltipTop = $derived.by(() => {
		if (!tooltip) return 0;
		const y = tooltipSide.up ? tooltip.y - 12 - tooltipHeight : tooltip.y + 16;
		return Math.min(Math.max(y, insetTop), height - legendHeight - tooltipHeight - 16);
	});

	function placeTooltip(n: SimNode) {
		const near = [...(neighbors.get(n) ?? [])];
		if (!near.length) {
			tooltipSide = { left: false, up: false };
			return;
		}
		const cx = near.reduce((s, m) => s + m.x, 0) / near.length;
		const cy = near.reduce((s, m) => s + m.y, 0) / near.length;
		tooltipSide = { left: cx > n.x, up: cy > n.y };
	}
	let hoveredFolder = $state<string | null>(null);
	let pinnedFolder = $state<string | null>(null);
	// Hovering previews a folder; clicking pins it (the only way on touch).
	const legendFolder = $derived(hoveredFolder ?? pinnedFolder);

	let nodes: SimNode[] = [];
	let edges: SimEdge[] = [];
	let neighbors = $state.raw(new Map<SimNode, Set<SimNode>>());
	let alpha = 1;
	let width = $state(0);
	let height = $state(0);
	let cam = { x: 0, y: 0, k: 1 };
	let startedAt = 0;
	let reducedMotion = false;
	let folderHubs = new Set<SimNode>();
	let cameraSettled = false;
	// Per-label opacity, eased so labels fade rather than pop as space opens up.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- plain scratch data, never rendered
	const labelAlpha = new Map<SimNode, number>();

	// Resolved theme colours, as [r, g, b].
	type RGB = [number, number, number];
	let palette: RGB[] = [];
	let fg: RGB = [20, 20, 20];
	let bg: RGB = [250, 250, 250];
	let muted: RGB = [120, 120, 120];
	let dark = false;

	const folders = $derived([...new Set(graph.nodes.map((n) => n.folder))].sort());
	const folderCounts = $derived(
		graph.nodes.reduce(
			(m, n) => m.set(n.folder, (m.get(n.folder) ?? 0) + 1),
			new Map<string, number>()
		)
	);
	let legendColors = $state<string[]>([]);

	function hash(s: string): number {
		let h = 2166136261;
		for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
		return (h >>> 0) / 4294967296;
	}

	const HUES = 8;
	const ringed = (folderIndex: number) => folderIndex >= HUES;
	const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

	const rgba = (c: RGB, a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

	/** Turns any CSS colour (oklch, var-resolved…) into rgb by painting one pixel. */
	function resolveColors() {
		if (!canvas) return;
		const probe = document.createElement('canvas');
		probe.width = probe.height = 1;
		const p = probe.getContext('2d', { willReadFrequently: true })!;
		const style = getComputedStyle(canvas);
		const toRgb = (css: string): RGB => {
			p.clearRect(0, 0, 1, 1);
			p.fillStyle = '#000';
			p.fillStyle = css;
			p.fillRect(0, 0, 1, 1);
			const d = p.getImageData(0, 0, 1, 1).data;
			return [d[0], d[1], d[2]];
		};
		bg = toRgb(style.getPropertyValue('--card').trim() || '#fff');
		fg = toRgb(style.getPropertyValue('--foreground').trim() || '#111');
		muted = toRgb(style.getPropertyValue('--muted-foreground').trim() || '#888');
		dark = (bg[0] * 0.299 + bg[1] * 0.587 + bg[2] * 0.114) / 255 < 0.5;
		// At most HUES evenly spaced hues, visited with a stride so neighbouring folders
		// get distant hues. Folders past that reuse a hue at another lightness and
		// are drawn as rings (see `ringed`), so no two folders look the same.
		const n = Math.max(Math.min(folders.length, HUES), 1);
		let stride = Math.max(1, Math.round(n * 0.382));
		while (gcd(stride, n) !== 1) stride++;
		palette = folders.map((_, i) => {
			const hue = (250 + ((((i % n) * stride) % n) * 360) / n) % 360;
			const second = i >= n;
			const l = dark ? (second ? 0.84 : 0.7) : second ? 0.5 : 0.62;
			return toRgb(`oklch(${l} ${dark ? 0.16 : 0.19} ${hue})`);
		});
		legendColors = palette.map((c) => rgba(c, 1));
	}

	function buildSim() {
		const prev = new Map(nodes.map((n) => [n.id, n]));
		const folderIndex = new Map(folders.map((f, i) => [f, i]));
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- plain scratch data, never rendered
		const degree = new Map<string, number>();
		for (const e of graph.edges) {
			const w = e.kind === 'link' ? 1 : 0.35;
			degree.set(e.source, (degree.get(e.source) ?? 0) + w);
			degree.set(e.target, (degree.get(e.target) ?? 0) + w);
		}
		const now = performance.now();
		nodes = graph.nodes.map((n, i) => {
			const old = prev.get(n.id);
			const fi = folderIndex.get(n.folder) ?? 0;
			// Seed each folder in its own wedge so clusters form without tangling.
			const angle = (fi / Math.max(folders.length, 1)) * Math.PI * 2 + (hash(n.id) - 0.5) * 0.8;
			const dist = 120 + hash(n.id + '#') * 90;
			const d = degree.get(n.id) ?? 0;
			return {
				id: n.id,
				node: n,
				title: n.title,
				folder: n.folder,
				tags: n.tags,
				x: old?.x ?? Math.cos(angle) * dist,
				y: old?.y ?? Math.sin(angle) * dist,
				vx: 0,
				vy: 0,
				r: 4.5 + Math.sqrt(d) * 2.6,
				degree: d,
				color: fi,
				phase: hash(n.id + '~') * Math.PI * 2,
				born: old ? old.born : now + i * 18,
				fixed: false
			};
		});
		labelAlpha.clear();
		// Each folder's best-connected memory, so every folder gets at least one name.
		folderHubs = new Set(
			[...Map.groupBy(nodes, (n) => n.folder).values()].map((group) =>
				group.reduce((best, n) => (n.degree > best.degree ? n : best))
			)
		);
		const byId = new Map(nodes.map((n) => [n.id, n]));
		edges = [];
		neighbors = new Map(nodes.map((n) => [n, new Set<SimNode>()]));
		for (const e of graph.edges) {
			const a = byId.get(e.source);
			const b = byId.get(e.target);
			if (!a || !b) continue;
			edges.push({ a, b, kind: e.kind, phase: hash(e.source + e.target) });
			neighbors.get(a)!.add(b);
			neighbors.get(b)!.add(a);
		}
		alpha = prev.size ? 0.5 : 1;
		if (!prev.size) for (let i = 0; i < 160; i++) tick();
	}

	function tick() {
		const n = nodes.length;
		// Folder centroids pull their members together.
		const cx = new Float64Array(folders.length);
		const cy = new Float64Array(folders.length);
		const cc = new Float64Array(folders.length);
		for (const a of nodes) {
			cx[a.color] += a.x;
			cy[a.color] += a.y;
			cc[a.color]++;
		}
		for (let i = 0; i < n; i++) {
			const a = nodes[i];
			for (let j = i + 1; j < n; j++) {
				const b = nodes[j];
				let dx = b.x - a.x;
				let dy = b.y - a.y;
				let d2 = dx * dx + dy * dy;
				if (d2 < 1) {
					dx = Math.random() - 0.5;
					dy = Math.random() - 0.5;
					d2 = 1;
				}
				const minD = a.r + b.r + 14;
				const f = (2200 / d2 + (d2 < minD * minD ? 0.6 : 0)) * alpha;
				const d = Math.sqrt(d2);
				const fx = (dx / d) * f;
				const fy = (dy / d) * f;
				a.vx -= fx;
				a.vy -= fy;
				b.vx += fx;
				b.vy += fy;
			}
		}
		for (const e of edges) {
			const rest = e.kind === 'link' ? 70 : 120;
			const k = e.kind === 'link' ? 0.05 : 0.012;
			const dx = e.b.x - e.a.x;
			const dy = e.b.y - e.a.y;
			const d = Math.sqrt(dx * dx + dy * dy) || 1;
			const f = (d - rest) * k * alpha;
			const fx = (dx / d) * f;
			const fy = (dy / d) * f;
			e.a.vx += fx;
			e.a.vy += fy;
			e.b.vx -= fx;
			e.b.vy -= fy;
		}
		for (const a of nodes) {
			const c = cc[a.color] || 1;
			// Unconnected memories get extra pull so they don't drift off and shrink the fit.
			const gravity = a.degree === 0 ? 0.03 : 0.006;
			a.vx += (cx[a.color] / c - a.x) * 0.012 * alpha - a.x * gravity * alpha;
			a.vy += (cy[a.color] / c - a.y) * 0.012 * alpha - a.y * gravity * alpha;
			if (a.fixed) {
				a.vx = a.vy = 0;
				continue;
			}
			a.vx *= 0.78;
			a.vy *= 0.78;
			a.x += a.vx;
			a.y += a.vy;
		}
		alpha = Math.max(alpha * 0.985, 0.02);
	}

	function bounds() {
		let x0 = Infinity,
			y0 = Infinity,
			x1 = -Infinity,
			y1 = -Infinity;
		for (const a of nodes) {
			x0 = Math.min(x0, a.x - a.r);
			y0 = Math.min(y0, a.y - a.r);
			x1 = Math.max(x1, a.x + a.r);
			y1 = Math.max(y1, a.y + a.r);
		}
		return { x0, y0, x1, y1 };
	}

	function fitTarget() {
		if (!nodes.length) return { x: 0, y: 0, k: 1 };
		const b = bounds();
		// Fit into the area between the header and the legend; labels hang below nodes.
		// Extra room at the sides for labels centred under the outermost nodes.
		const pad = 20;
		const padX = Math.min(64, width * 0.08);
		const top = insetTop + pad;
		const bottom = height - legendHeight - 12 - pad;
		const k = Math.max(
			Math.min(
				(width - padX * 2) / Math.max(b.x1 - b.x0, 1),
				Math.max(bottom - top, 80) / Math.max(b.y1 - b.y0, 1),
				1.8
			),
			0.2
		);
		const shift = ((top + bottom) / 2 - height / 2) / k;
		return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 - shift, k };
	}

	const toScreen = (x: number, y: number) => [
		(x - cam.x) * cam.k + width / 2,
		(y - cam.y) * cam.k + height / 2
	];
	const toWorld = (sx: number, sy: number) => [
		(sx - width / 2) / cam.k + cam.x,
		(sy - height / 2) / cam.k + cam.y
	];

	function nodeAt(sx: number, sy: number): SimNode | null {
		const [wx, wy] = toWorld(sx, sy);
		let best: SimNode | null = null;
		let bestD = Infinity;
		for (const a of nodes) {
			const d = Math.hypot(a.x - wx, a.y - wy);
			if (d < a.r + 6 / cam.k && d < bestD) {
				best = a;
				bestD = d;
			}
		}
		return best;
	}

	const ease = (t: number) => 1 - Math.pow(1 - Math.min(Math.max(t, 0), 1), 3);

	function draw(now: number) {
		const ctx = canvas?.getContext('2d');
		if (!ctx || !width) return;
		const dpr = window.devicePixelRatio || 1;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, width, height);

		const t = (now - startedAt) / 1000;
		const focus = hovered ?? nodes.find((n) => n.id === selected) ?? null;
		const lit = focus ? neighbors.get(focus) : null;
		const isLit = (n: SimNode) =>
			legendFolder !== null && !focus
				? n.folder === legendFolder
				: !focus || n === focus || !!lit?.has(n);
		const bob = (n: SimNode) =>
			reducedMotion
				? [0, 0]
				: [Math.sin(t * 0.7 + n.phase) * 1.6, Math.cos(t * 0.55 + n.phase) * 1.6];
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- plain scratch data, never rendered
		const pos = new Map<SimNode, number[]>();
		for (const n of nodes) {
			const [bx, by] = bob(n);
			pos.set(n, toScreen(n.x + bx, n.y + by));
		}
		const grow = (n: SimNode) => ease((now - n.born) / 700);

		// Edges.
		ctx.lineCap = 'round';
		for (const e of edges) {
			const [ax, ay] = pos.get(e.a)!;
			const [bx, by] = pos.get(e.b)!;
			const on =
				legendFolder !== null && !focus
					? e.a.folder === legendFolder && e.b.folder === legendFolder
					: !focus || e.a === focus || e.b === focus;
			const g = Math.min(grow(e.a), grow(e.b));
			if (g <= 0) continue;
			const ca = palette[e.a.color] ?? muted;
			const cb = palette[e.b.color] ?? muted;
			// White cards wash lines out, so light mode draws them stronger.
			const base = e.kind === 'link' ? (dark ? 0.42 : 0.55) : dark ? 0.3 : 0.42;
			const a = (on ? (focus ? 0.9 : base) : 0.08) * g;
			const grad = ctx.createLinearGradient(ax, ay, bx, by);
			grad.addColorStop(0, rgba(ca, a));
			grad.addColorStop(1, rgba(cb, a));
			ctx.strokeStyle = grad;
			ctx.lineWidth = (e.kind === 'link' ? 1.3 : 0.9) * (on && focus ? 1.6 : 1);
			ctx.setLineDash(e.kind === 'tag' ? [2, 4] : []);
			ctx.beginPath();
			ctx.moveTo(ax, ay);
			ctx.lineTo(bx, by);
			ctx.stroke();
		}
		ctx.setLineDash([]);

		// Signals travelling along links.
		if (!reducedMotion) {
			for (const e of edges) {
				if (e.kind !== 'link') continue;
				if (!isLit(e.a) || !isLit(e.b)) continue;
				const [ax, ay] = pos.get(e.a)!;
				const [bx, by] = pos.get(e.b)!;
				const p = (t * 0.22 + e.phase) % 1;
				// Fades in and out at the ends, so sparks never sit on a node.
				const fade = Math.sin(p * Math.PI) ** 2 * Math.min(grow(e.a), grow(e.b));
				const x = ax + (bx - ax) * p;
				const y = ay + (by - ay) * p;
				const c = palette[p < 0.5 ? e.a.color : e.b.color] ?? fg;
				// A small soft glow around a crisp core reads as a travelling spark.
				const gr = 4 * Math.min(cam.k, 1.6) ** 0.6;
				const glow = ctx.createRadialGradient(x, y, 0, x, y, gr);
				glow.addColorStop(0, rgba(c, 0.5 * fade));
				glow.addColorStop(1, rgba(c, 0));
				ctx.fillStyle = glow;
				ctx.beginPath();
				ctx.arc(x, y, gr, 0, Math.PI * 2);
				ctx.fill();
				ctx.fillStyle = rgba(mix(c, [255, 255, 255], dark ? 0.5 : 0.2), fade);
				ctx.beginPath();
				ctx.arc(x, y, 1.5, 0, Math.PI * 2);
				ctx.fill();
			}
		}

		// Nodes: soft halo, solid core, bright rim.
		for (const n of nodes) {
			const g = grow(n);
			if (g <= 0) continue;
			const [x, y] = pos.get(n)!;
			const c = palette[n.color] ?? muted;
			const on = isLit(n);
			const pulse = reducedMotion ? 1 : 1 + Math.sin(t * 1.6 + n.phase) * 0.06;
			const r = n.r * Math.min(cam.k, 1.6) ** 0.6 * g * (n === focus ? 1.25 : 1);
			// A node with no links would blank the whole map, so dim the rest less.
			const fade = on ? 1 : focus && !lit?.size ? 0.6 : 0.15;

			// Only lit nodes glow, so a focused neighbourhood or folder stands out.
			if (on) {
				const haloR = r * (n === focus ? 3.6 : dark ? 2.6 : 2) * pulse;
				const halo = ctx.createRadialGradient(x, y, r * 0.4, x, y, haloR);
				halo.addColorStop(0, rgba(c, dark ? 0.38 : 0.18));
				halo.addColorStop(1, rgba(c, 0));
				ctx.fillStyle = halo;
				ctx.beginPath();
				ctx.arc(x, y, haloR, 0, Math.PI * 2);
				ctx.fill();
			}

			const core = ctx.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.1, x, y, r);
			core.addColorStop(0, rgba(mix(c, [255, 255, 255], 0.45), fade));
			core.addColorStop(1, rgba(c, fade));
			ctx.fillStyle = core;
			ctx.beginPath();
			ctx.arc(x, y, r, 0, Math.PI * 2);
			ctx.fill();
			if (ringed(n.color)) {
				// Second-round folders: a tinted centre tells them apart from shared hues
				// without making the ring look heavier than a filled node.
				ctx.fillStyle = rgba(mix(bg, c, 0.22), fade);
				ctx.beginPath();
				ctx.arc(x, y, r * 0.56, 0, Math.PI * 2);
				ctx.fill();
			}

			if (n.id === selected || n === hovered) {
				// A detached foreground ring, so selection never reads as a ringed folder.
				ctx.lineWidth = 2;
				ctx.strokeStyle = rgba(bg, 0.9);
				ctx.beginPath();
				ctx.arc(x, y, r + 2.5, 0, Math.PI * 2);
				ctx.stroke();
				ctx.strokeStyle = rgba(fg, n.id === selected ? 0.9 : 0.6);
				ctx.beginPath();
				ctx.arc(x, y, r + 5, 0, Math.PI * 2);
				ctx.stroke();
			}
		}

		// Labels: hubs always, everything once zoomed in, and the focused neighbourhood.
		ctx.font = '500 11.5px "Inter Variable", system-ui, sans-serif';
		ctx.textAlign = 'center';
		ctx.textBaseline = 'top';
		ctx.lineJoin = 'round';
		// Highest priority first; a label that would collide with a placed label or
		// with any node is skipped rather than drawn on top.
		const rank = (n: SimNode) =>
			(n === focus ? 1e6 : 0) +
			(n.id === selected ? 1e5 : 0) +
			(lit?.has(n) ? 1e4 : 0) +
			(folderHubs.has(n) ? 5e3 : 0) +
			n.degree;
		type Box = { x0: number; y0: number; x1: number; y1: number };
		// Collisions use the un-bobbed positions so the idle drift can't flip labels.
		const nodeBoxes = new Map<SimNode, Box>(
			nodes.map((n) => {
				const [x, y] = toScreen(n.x, n.y);
				const r = n.r * Math.min(cam.k, 1.6) ** 0.6;
				return [n, { x0: x - r, y0: y - r, x1: x + r, y1: y + r }];
			})
		);
		const placed: Box[] = [];
		const hit = (b: Box, o: Box, slack: number) =>
			b.x0 - slack < o.x1 && b.x1 + slack > o.x0 && b.y0 - slack < o.y1 && b.y1 + slack > o.y0;
		// Hysteresis: a label already showing keeps its spot unless it clearly
		// collides, while a new one needs clear space around it. A label never
		// collides with its own node, which it hangs right below.
		const overlaps = (b: Box, slack: number, self: SimNode) =>
			placed.some((o) => hit(b, o, slack)) ||
			[...nodeBoxes].some(([m, o]) => m !== self && hit(b, o, slack));
		for (const n of [...nodes].sort((a, b) => rank(b) - rank(a))) {
			const g = grow(n);
			const [x, y] = pos.get(n)!;
			const [sx, sy] = toScreen(n.x, n.y);
			const r = n.r * Math.min(cam.k, 1.6) ** 0.6 * (n === focus ? 1.25 : 1);
			const label = n.title.length > 26 ? n.title.slice(0, 25) + '…' : n.title;
			const w = ctx.measureText(label).width;
			// Slide labels back inside the canvas instead of letting the edge clip them.
			const clampX = (cx: number) => Math.min(Math.max(cx, w / 2 + 8), width - w / 2 - 8);
			const lx = clampX(x);
			const bx = clampX(sx);
			const box = { x0: bx - w / 2 - 3, y0: sy + r + 3, x1: bx + w / 2 + 3, y1: sy + r + 20 };
			const shown = labelAlpha.get(n) ?? 0;
			const want =
				g >= 0.6 &&
				isLit(n) &&
				!(n === hovered && tooltip) && // the tooltip already names it
				(n === focus ||
					(shown > 0
						? !overlaps(box, -1, n)
						: cameraSettled && now - startedAt > 900 && !overlaps(box, 4, n)));
			if (want) placed.push(box);
			const next = reducedMotion ? +want : shown + ((want ? 1 : 0) - shown) * 0.18;
			labelAlpha.set(n, next < 0.02 ? 0 : next);
			if (next < 0.02) continue;
			const a = (focus && n !== focus ? 0.85 : 1) * next;
			if (n === focus || n.id === selected) {
				// A solid pill keeps the key label readable over the links behind it.
				ctx.fillStyle = rgba(bg, 0.92 * a);
				ctx.beginPath();
				ctx.roundRect(lx - w / 2 - 6, y + r + 2, w + 12, 18, 6);
				ctx.fill();
			}
			ctx.lineWidth = 3;
			ctx.strokeStyle = rgba(bg, 0.9 * a);
			ctx.strokeText(label, lx, y + r + 5);
			ctx.fillStyle = rgba(n === focus ? fg : mix(fg, muted, 0.3), a);
			ctx.fillText(label, lx, y + r + 5);
		}
	}

	function mix(a: RGB, b: RGB, t: number): RGB {
		return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t].map(
			Math.round
		) as RGB;
	}

	function frame(now: number) {
		if (alpha > 0.021 || nodes.some((n) => n.fixed)) tick();
		cameraSettled = true;
		if (autoFit) {
			const target = fitTarget();
			cameraSettled = Math.abs(cam.k - target.k) / target.k < 0.02;
			const s = reducedMotion ? 1 : 0.08;
			cam.x += (target.x - cam.x) * s;
			cam.y += (target.y - cam.y) * s;
			cam.k += (target.k - cam.k) * s;
		}
		draw(now);
	}

	// Pointer handling: drag a node, pan the canvas, pinch or wheel to zoom.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- plain scratch data, never rendered
	const pointers = new Map<number, { x: number; y: number }>();
	let drag = $state.raw<{ node: SimNode | null; sx: number; sy: number; moved: boolean } | null>(
		null
	);
	let pinch: { d: number; k: number } | null = null;

	function local(e: PointerEvent | WheelEvent) {
		const rect = canvas!.getBoundingClientRect();
		return { x: e.clientX - rect.left, y: e.clientY - rect.top };
	}

	function onPointerDown(e: PointerEvent) {
		const p = local(e);
		pointers.set(e.pointerId, p);
		canvas!.setPointerCapture(e.pointerId);
		if (pointers.size === 2) {
			const [a, b] = [...pointers.values()];
			pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), k: cam.k };
			if (drag?.node) drag.node.fixed = false;
			drag = null;
			return;
		}
		const node = nodeAt(p.x, p.y);
		drag = { node, sx: p.x, sy: p.y, moved: false };
	}

	function onPointerMove(e: PointerEvent) {
		const p = local(e);
		if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
		if (pinch && pointers.size === 2) {
			const [a, b] = [...pointers.values()];
			cam.k = clampK((pinch.k * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.d);
			autoFit = false;
			return;
		}
		if (!drag) {
			const n = nodeAt(p.x, p.y);
			if (n && n !== hovered) placeTooltip(n);
			hovered = n;
			tooltip = n ? p : null;
			canvas!.style.cursor = n ? 'pointer' : 'grab';
			return;
		}
		const dx = p.x - drag.sx;
		const dy = p.y - drag.sy;
		if (!drag.moved && Math.hypot(dx, dy) < 4) return;
		drag.moved = true;
		tooltip = null;
		if (drag.node) {
			const [wx, wy] = toWorld(p.x, p.y);
			drag.node.fixed = true;
			drag.node.x = wx;
			drag.node.y = wy;
			hovered = drag.node;
			alpha = Math.max(alpha, 0.35);
		} else {
			cam.x -= dx / cam.k;
			cam.y -= dy / cam.k;
			drag.sx = p.x;
			drag.sy = p.y;
			autoFit = false;
			canvas!.style.cursor = 'grabbing';
		}
	}

	function onPointerUp(e: PointerEvent) {
		pointers.delete(e.pointerId);
		if (pointers.size < 2) pinch = null;
		if (!drag) return;
		if (drag.node) {
			drag.node.fixed = false;
			if (!drag.moved) onselect?.(drag.node.node);
		}
		drag = null;
		canvas!.style.cursor = hovered ? 'pointer' : 'grab';
	}

	function onLeave() {
		if (drag) return;
		hovered = null;
		tooltip = null;
	}

	const clampK = (k: number) => Math.min(Math.max(k, 0.25), 4);

	function onWheel(e: WheelEvent) {
		e.preventDefault();
		const p = local(e);
		const [wx, wy] = toWorld(p.x, p.y);
		cam.k = clampK(cam.k * Math.exp(-e.deltaY * 0.0015));
		// Keep the point under the cursor in place.
		cam.x = wx - (p.x - width / 2) / cam.k;
		cam.y = wy - (p.y - height / 2) / cam.k;
		autoFit = false;
	}

	function resize() {
		if (!wrap || !canvas) return;
		const rect = wrap.getBoundingClientRect();
		width = rect.width;
		height = rect.height;
		const dpr = window.devicePixelRatio || 1;
		canvas.width = Math.round(width * dpr);
		canvas.height = Math.round(height * dpr);
	}

	$effect(() => {
		void graph;
		untrack(buildSim);
	});

	onMount(() => {
		reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		startedAt = performance.now();
		resolveColors();
		resize();
		const t = fitTarget();
		cam = { ...t };
		const ro = new ResizeObserver(resize);
		ro.observe(wrap!);
		// Re-read colours when the theme class flips.
		const mo = new MutationObserver(resolveColors);
		mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
		let raf = requestAnimationFrame(function loop(now) {
			frame(now);
			raf = requestAnimationFrame(loop);
		});
		return () => {
			cancelAnimationFrame(raf);
			ro.disconnect();
			mo.disconnect();
		};
	});

	$effect(() => {
		void folders;
		untrack(resolveColors);
	});
</script>

<svelte:window
	onkeydown={(e) => {
		if (e.key === 'Escape' && pinnedFolder !== null && !e.defaultPrevented) pinnedFolder = null;
	}}
/>

<div bind:this={wrap} class="relative size-full overflow-hidden">
	<canvas
		bind:this={canvas}
		class="absolute inset-0 size-full touch-none"
		style="cursor: grab"
		aria-hidden="true"
		onpointerdown={onPointerDown}
		onpointermove={onPointerMove}
		onpointerup={onPointerUp}
		onpointercancel={onPointerUp}
		onpointerleave={onLeave}
		onwheel={onWheel}
	></canvas>

	{#if hovered && tooltip && !drag}
		{@const links = neighbors.get(hovered)?.size ?? 0}
		<div
			bind:clientHeight={tooltipHeight}
			class="pointer-events-none absolute z-10 max-w-64 rounded-xl border bg-popover/95 px-3 py-2 text-popover-foreground shadow-lg backdrop-blur"
			bind:clientWidth={tooltipWidth}
			style="left: {tooltipLeft}px; top: {tooltipTop}px"
		>
			<p class="line-clamp-2 text-sm font-medium break-words">{hovered.title}</p>
			<p class="text-xs text-muted-foreground">
				{hovered.folder || 'Top level'} ·
				{links === 0 ? 'No links yet' : `${links} ${links === 1 ? 'connection' : 'connections'}`}
			</p>
			{#if hovered.tags.length}
				<p class="mt-1 line-clamp-1 text-xs text-muted-foreground">
					{hovered.tags.map((t) => `#${t}`).join(' ')}
				</p>
			{/if}
		</div>
	{/if}

	<div class="pointer-events-none absolute inset-x-3 bottom-3 flex items-end justify-between gap-3">
		<ul
			bind:clientHeight={legendHeight}
			class="pointer-events-auto flex min-w-0 flex-1 flex-wrap gap-x-3 gap-y-1 text-xs text-foreground/90"
			aria-label="Folders"
			onpointerleave={() => (hoveredFolder = null)}
		>
			{#each folders as folder, i (folder)}
				<li>
					<button
						type="button"
						class="flex cursor-pointer items-center gap-1.5 rounded-sm transition-opacity focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none aria-pressed:font-medium aria-pressed:text-foreground {legendFolder !==
							null && legendFolder !== folder
							? 'opacity-60'
							: ''}"
						aria-pressed={pinnedFolder === folder}
						onpointerenter={(e) => {
							if (e.pointerType === 'mouse') hoveredFolder = folder;
						}}
						onclick={() => (pinnedFolder = pinnedFolder === folder ? null : folder)}
						onfocus={() => (hoveredFolder = folder)}
						onblur={() => (hoveredFolder = null)}
					>
						<span
							class="size-2.5 rounded-full"
							style="background: {ringed(i)
								? `radial-gradient(circle closest-side, var(--card) 0 54%, ${legendColors[i]} 60%)`
								: legendColors[i]}; box-shadow: 0 0 6px {legendColors[i]}"
						></span>
						{folder || 'Top level'}
						<span class="hidden text-muted-foreground tabular-nums sm:inline"
							>{folderCounts.get(folder)}</span
						>
					</button>
				</li>
			{/each}
		</ul>
		{#if pinnedFolder !== null}
			<Button
				variant="outline"
				size="sm"
				class="pointer-events-auto h-7 shrink-0 gap-1.5 bg-background/80 px-2 text-xs text-muted-foreground backdrop-blur"
				title="Show all folders (Esc)"
				onclick={() => (pinnedFolder = null)}
			>
				<XIcon class="size-3.5" />Show all
			</Button>
		{/if}
		{#if !autoFit}
			<Button
				variant="outline"
				size="sm"
				class="pointer-events-auto h-7 shrink-0 gap-1.5 bg-background/80 px-2 text-xs text-muted-foreground backdrop-blur"
				title="Fit the map to the view"
				onclick={() => (autoFit = true)}
			>
				<LocateFixedIcon class="size-3.5" />Recenter
			</Button>
		{/if}
	</div>
</div>
