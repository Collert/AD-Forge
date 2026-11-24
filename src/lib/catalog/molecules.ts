/**
 * Skeletal repeat-unit drawings of the polymers we print, keyed by the
 * product's `custom.molecule` metafield. Each is built from a short token list:
 * 'open' / { close } brackets, atoms ({ a: label ('' = carbon), o: incoming
 * bond order, subs }), and 'ring' (a benzene ring in the chain). A sub is a
 * single bond `{ l, o, s }` (s = spread angle), a `{ path }` of them, or
 * `{ ring }` for a hanging phenyl.
 */

type Sub = { l?: string; o?: number; s?: number; b?: { l: string; o?: number; left?: boolean } };
type SubSpec = Sub | { path: Sub[] } | { ring: true; flip?: boolean };
type Token = 'open' | 'ring' | { close: string } | { a: string; o?: number; subs?: SubSpec[] };

export type Molecule = {
	viewBox: string;
	width: number;
	height: number;
	lines: { x1: number; y1: number; x2: number; y2: number }[];
	rings: { cx: number; cy: number }[];
	labels: { t: string; x: number; y: number }[];
	subs: { t: string; x: number; y: number }[];
};

const CO: Sub = { l: 'O', o: 2 };

const specs: Record<string, Token[]> = {
	PLA: ['open', { a: 'O' }, { a: '', subs: [{}] }, { a: '', subs: [CO] }, { close: 'n' }],
	PETG: ['open', { a: 'O' }, { a: '', subs: [CO] }, 'ring', { a: '', subs: [CO] }, { a: 'O' }, { a: '' }, { a: '' }, { close: 'n' }],
	PET: ['open', { a: 'O' }, { a: '', subs: [CO] }, 'ring', { a: '', subs: [CO] }, { a: 'O' }, { a: '' }, { a: '' }, { close: 'n' }],
	ABS: [
		'open', { a: '' }, { a: '', subs: [{ path: [{}, { l: 'N', o: 3 }] }] }, { close: 'x' },
		'open', { a: '' }, { a: '' }, { a: '', o: 2 }, { a: '' }, { close: 'y' },
		'open', { a: '' }, { a: '', subs: [{ ring: true }] }, { close: 'z' }
	],
	ASA: [
		'open', { a: '' }, { a: '', subs: [{ path: [{}, { l: 'N', o: 3 }] }] }, { close: 'x' },
		'open', { a: '' }, { a: '', subs: [{ ring: true, flip: true }] }, { close: 'y' },
		'open', { a: '' }, { a: '', subs: [{ path: [{ b: { l: 'O', o: 2, left: true } }, { l: 'OBu' }] }] }, { close: 'z' }
	],
	TPU: ['open', { a: 'O' }, { a: '', subs: [CO] }, { a: 'NH' }, 'ring', { a: 'NH' }, { a: '', subs: [CO] }, { a: 'O' }, { a: '' }, { a: '' }, { close: 'n' }],
	PC: ['open', { a: 'O' }, 'ring', { a: '', subs: [{ s: -38 }, { s: 38 }] }, 'ring', { a: 'O' }, { a: '', subs: [CO] }, { close: 'n' }],
	PA6: ['open', { a: 'NH' }, { a: '' }, { a: '' }, { a: '' }, { a: '' }, { a: '' }, { a: '', subs: [CO] }, { close: 'n' }],
	PA12: [
		'open', { a: 'NH' }, { a: '' }, { a: '' }, { a: '' }, { a: '' }, { a: '' }, { a: '' }, { a: '' }, { a: '' }, { a: '' }, { a: '' }, { a: '' },
		{ a: '', subs: [CO] }, { close: 'n' }
	],
	PPS: ['open', 'ring', { a: 'S' }, { close: 'n' }],
	PPA: ['open', { a: 'NH' }, { a: '' }, { a: '' }, { a: '' }, { a: '' }, { a: '' }, { a: '' }, { a: 'NH' }, { a: '', subs: [CO] }, 'ring', { a: '', subs: [CO] }, { close: 'n' }]
};

/** Largest size a drawing is shown at (px), and the most it's scaled up. */
const MAX_W = 216;
const MAX_H = 74;
const MAX_SCALE = 1.15;

const built = new Map<string, Molecule | null>();

export function molecule(key: string | undefined): Molecule | null {
	if (!key) return null;
	if (!built.has(key)) built.set(key, specs[key] ? build(specs[key]) : null);
	return built.get(key)!;
}

function build(spec: Token[]): Molecule {
	const B = 17.32, H = 10, R = 20;
	const lines: Molecule['lines'] = [], rings: Molecule['rings'] = [], labels: Molecule['labels'] = [], subs: Molecule['subs'] = [];
	const pts: [number, number][] = [];
	let x = 0, y = H, up = true;
	let pend: { k: 'open' | 'close'; t?: string }[] = [];
	const rad = (deg: number) => (deg * Math.PI) / 180;

	const line = (ax: number, ay: number, bx: number, by: number) => {
		lines.push({ x1: ax, y1: ay, x2: bx, y2: by });
		pts.push([ax, ay], [bx, by]);
	};
	const bond = (ax: number, ay: number, bx: number, by: number, o = 1) => {
		if (o === 1) return line(ax, ay, bx, by);
		const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy), nx = -dy / len, ny = dx / len;
		for (const k of o === 2 ? [-2, 2] : [-3, 0, 3]) line(ax + nx * k, ay + ny * k, bx + nx * k, by + ny * k);
	};
	const bracket = (mx: number, my: number, kind: 'open' | 'close', sub?: string) => {
		const h = 15, s = kind === 'open' ? 4 : -4;
		line(mx, my - h, mx, my + h);
		line(mx, my - h, mx + s, my - h);
		line(mx, my + h, mx + s, my + h);
		if (kind === 'close' && sub) {
			subs.push({ t: sub, x: mx + 2, y: my + h + 9 });
			pts.push([mx + 10, my + h + 10]);
		}
	};
	const label = (t: string | undefined, ax: number, ay: number) => {
		if (!t) return;
		labels.push({ t, x: ax, y: ay });
		pts.push([ax - 10, ay - 8], [ax + 10, ay + 8]);
	};
	const ring = (cx: number, cy: number, angles: number[]) => {
		const v = angles.map((a) => [cx + R * Math.cos(rad(a)), cy + R * Math.sin(rad(a))] as const);
		v.forEach((p, k) => line(p[0], p[1], v[(k + 1) % 6][0], v[(k + 1) % 6][1]));
		rings.push({ cx, cy });
	};
	/** One zig-zag step along the backbone, placing any pending brackets on the bond. */
	const step = (o = 1) => {
		const nx = x + B, ny = up ? 0 : H;
		const at = (f: number) => [x + (nx - x) * f, y + (ny - y) * f] as const;
		if (pend.length === 1) bracket(...at(0.5), pend[0].k, pend[0].t);
		else if (pend.length === 2) {
			bracket(...at(0.3), pend[0].k, pend[0].t);
			bracket(...at(0.7), pend[1].k, pend[1].t);
		}
		pend = [];
		bond(x, y, nx, ny, o);
		x = nx;
		y = ny;
		up = !up;
	};

	spec.forEach((tk, i) => {
		if (tk === 'open') return void pend.push({ k: 'open' });
		if (tk === 'ring') {
			step();
			ring(x + R, y, [180, 240, 300, 0, 60, 120]);
			x += 2 * R;
			return;
		}
		if ('close' in tk) {
			pend.push({ k: 'close', t: tk.close });
			if (i === spec.length - 1) step();
			return;
		}
		const atom = tk;
		step(atom.o);
		label(atom.a, x, y);
		const out = y === 0 ? -1 : 1;
		for (const sb of atom.subs ?? []) {
			if ('ring' in sb) {
				const dir = sb.flip ? -out : out;
				bond(x, y, x, y + dir * 20);
				ring(x, y + dir * 40, [-90, -30, 30, 90, 150, 210]);
				continue;
			}
			const path = 'path' in sb ? sb.path : [sb];
			const ang = (out < 0 ? -90 : 90) + ('s' in sb ? (sb.s ?? 0) : 0);
			let px = x, py = y;
			for (const p of path) {
				const ex = px + 20 * Math.cos(rad(ang)), ey = py + 20 * Math.sin(rad(ang));
				bond(px, py, ex, ey, p.o);
				label(p.l, ex, ey);
				if (p.b) {
					const ba = rad(ang + (p.b.left ? 62 : -62) * (out < 0 ? -1 : 1));
					const bx = ex + 18 * Math.cos(ba), by = ey + 18 * Math.sin(ba);
					bond(ex, ey, bx, by, p.b.o);
					label(p.b.l, bx, by);
				}
				px = ex;
				py = ey;
			}
		}
	});

	const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
	const pad = 4;
	const ox = Math.min(...xs) - pad, oy = Math.min(...ys) - pad;
	const w = Math.max(...xs) - ox + pad, h = Math.max(...ys) - oy + pad;
	const s = Math.min(MAX_W / w, MAX_H / h, MAX_SCALE);
	const r1 = (v: number) => Math.round(v * 10) / 10;
	return {
		viewBox: [ox, oy, w, h].map(r1).join(' '),
		width: r1(w * s),
		height: r1(h * s),
		lines: lines.map((l) => ({ x1: r1(l.x1), y1: r1(l.y1), x2: r1(l.x2), y2: r1(l.y2) })),
		rings: rings.map((r) => ({ cx: r1(r.cx), cy: r1(r.cy) })),
		labels: labels.map((l) => ({ ...l, x: r1(l.x), y: r1(l.y) })),
		subs: subs.map((l) => ({ ...l, x: r1(l.x), y: r1(l.y) }))
	};
}
