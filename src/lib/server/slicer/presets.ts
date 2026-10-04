/**
 * OrcaSlicer's bundled system presets: printers ("machine"), print profiles
 * ("process") and filaments, read from the install's profiles folder.
 *
 * Presets inherit from each other ("Bambu PETG HF @BBL X1C" → "Bambu PETG HF
 * @base" → "fdm_filament_pet" → …), and the CLI does not follow `inherits` for
 * a preset loaded from a file: it fills the gaps with built-in defaults (a
 * 200 mm bed, zero filament density). So each preset is flattened here, parent
 * first and child keys winning, before it's handed to the slicer.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { orcaProfilesDir, SlicerError } from './orca';

export type PresetKind = 'machine' | 'process' | 'filament';

export type Preset = {
	name: string;
	type: string;
	inherits?: string;
	instantiation?: string;
	compatible_printers?: string[];
	[key: string]: unknown;
};

/** Shared filament definitions other vendors' filaments inherit from. */
const LIBRARY_VENDOR = 'OrcaFilamentLibrary';

type Index = Map<string, Preset>;
const indexes = new Map<string, Promise<Index>>();

/** Every preset in a vendor folder, by name. Read once. */
function vendorIndex(vendor: string): Promise<Index> {
	let index = indexes.get(vendor);
	if (!index) {
		index = readVendor(vendor);
		indexes.set(vendor, index);
		index.catch(() => indexes.delete(vendor));
	}
	return index;
}

async function readVendor(vendor: string): Promise<Index> {
	const root = path.join(orcaProfilesDir(), vendor);
	let files: string[];
	try {
		files = (await readdir(root, { recursive: true })).filter((f) => f.endsWith('.json'));
	} catch (err) {
		throw new SlicerError('Accurate quotes are unavailable right now.', 503, `No OrcaSlicer profiles at ${root}: ${(err as Error).message}`);
	}
	const index: Index = new Map();
	await Promise.all(
		files.map(async (file) => {
			try {
				const preset = JSON.parse(await readFile(path.join(root, file), 'utf8'));
				if (typeof preset?.name === 'string' && typeof preset.type === 'string') index.set(preset.name, preset);
			} catch {
				// Not a preset (or unreadable): skip it.
			}
		})
	);
	return index;
}

async function find(vendor: string, name: string): Promise<Preset | undefined> {
	return (await vendorIndex(vendor)).get(name) ?? (vendor === LIBRARY_VENDOR ? undefined : (await vendorIndex(LIBRARY_VENDOR)).get(name));
}

const flattened = new Map<string, Preset>();

/** A preset with its whole `inherits` chain merged in, ready to load on its own. Returns a copy to modify freely. */
export async function flatten(vendor: string, name: string): Promise<Preset> {
	const key = `${vendor}/${name}`;
	let preset = flattened.get(key);
	if (!preset) {
		preset = await merge(vendor, name);
		flattened.set(key, preset);
	}
	return { ...preset };
}

async function merge(vendor: string, name: string): Promise<Preset> {
	const chain: Preset[] = [];
	for (let next: string | undefined = name; next; ) {
		const preset = await find(vendor, next);
		if (!preset) throw new SlicerError('Accurate quotes are unavailable right now.', 503, `OrcaSlicer preset "${next}" not found (${vendor})`);
		if (chain.includes(preset)) break;
		chain.push(preset);
		next = preset.inherits || undefined;
	}
	const merged = Object.assign({}, ...chain.reverse()) as Preset;
	merged.name = name;
	merged.inherits = '';
	return merged;
}

/** Instantiable presets of one kind that list `machine` as compatible, flattened. */
async function compatible(vendor: string, kind: PresetKind, machine: string): Promise<Preset[]> {
	const index = await vendorIndex(vendor);
	const names = [...index.values()]
		.filter((p) => p.type === kind && p.instantiation === 'true' && p.compatible_printers?.includes(machine))
		.map((p) => p.name);
	return Promise.all(names.map((n) => flatten(vendor, n)));
}

/** "Bambu Lab X1 Carbon" + 0.4 → the flattened "Bambu Lab X1 Carbon 0.4 nozzle" machine preset. */
export async function machinePreset(vendor: string, printer: string, nozzle: number): Promise<Preset> {
	const name = `${printer} ${nozzle.toFixed(1)} nozzle`;
	const preset = (await vendorIndex(vendor)).get(name);
	if (preset?.type !== 'machine') throw new SlicerError(`We can't slice for a ${nozzle} mm nozzle on this printer yet.`, 400, `No machine preset "${name}"`);
	return flatten(vendor, name);
}

/**
 * The machine's print profile closest to `layerHeight`, preferring the
 * "Standard" one at each height. Customer settings are applied per object on
 * top of it, so this only sets what the configurator doesn't expose (speeds,
 * accelerations, seams…).
 */
export async function processPreset(vendor: string, machine: string, layerHeight: number): Promise<Preset> {
	const presets = await compatible(vendor, 'process', machine);
	if (!presets.length) throw new SlicerError('Accurate quotes are unavailable right now.', 503, `No process presets for "${machine}"`);
	const score = (p: Preset) => Math.abs(Number(p.layer_height) - layerHeight) * 10 + (/standard/i.test(p.name) ? 0 : 0.001);
	return presets.reduce((best, p) => (score(p) < score(best) ? p : best));
}

/**
 * The filament preset for a store material on this machine. `wanted` is the
 * product's preset name (with or without the "@printer" suffix) or its title
 * ("PETG HF"); the match is, in order: that exact preset; "Bambu <title>";
 * the longest preset name the title starts with ("PLA Silk Dual Color" →
 * "Bambu PLA Silk"); a Generic preset of the same plastic; any preset of it.
 */
export async function filamentPreset(vendor: string, machine: string, wanted: string): Promise<Preset> {
	const presets = await compatible(vendor, 'filament', machine);
	const base = (p: Preset) => p.name.replace(/\s*@.*$/, '').toLowerCase();
	const plain = (name: string) => name.replace(/^(bambu|generic)\s+/i, '');
	const want = wanted.trim().toLowerCase();

	const exact = presets.find((p) => p.name.toLowerCase() === want) ?? presets.find((p) => base(p) === want) ?? presets.find((p) => base(p) === `bambu ${want}`);
	if (exact) return exact;

	const startsWith = (p: Preset) => {
		const name = plain(base(p));
		return want === name || want.startsWith(`${name} `);
	};
	const prefixed = presets
		.filter(startsWith)
		.sort((a, b) => plain(base(b)).length - plain(base(a)).length || Number(base(a).startsWith('generic')) - Number(base(b).startsWith('generic')))[0];
	if (prefixed) return prefixed;

	const family = plasticOf(want);
	const sameType = presets.filter((p) => String((p.filament_type as string[] | undefined)?.[0] ?? '').toUpperCase() === family);
	const fallback = sameType.find((p) => base(p).startsWith('generic')) ?? sameType[0];
	if (fallback) return fallback;
	throw new SlicerError(`We can't slice ${wanted} on this printer yet.`, 400, `No filament preset for "${wanted}" on "${machine}"`);
}

/** Orca's `filament_type` for a material title: "PETG HF" → "PETG", "PA6-CF" → "PA-CF". */
function plasticOf(title: string): string {
	const t = title.toUpperCase();
	const fibre = /-(CF|GF)\b/.exec(t)?.[1];
	const families = ['PETG', 'PCTG', 'PET', 'PLA', 'ABS', 'ASA', 'TPU', 'PC', 'PPS', 'PPA', 'PVA', 'HIPS', 'PA'];
	const family = families.find((f) => new RegExp(`\\b${f}\\d*\\b`).test(t)) ?? 'PLA';
	return fibre && ['PA', 'PET', 'PPS', 'PPA'].includes(family) ? `${family}-${fibre}` : family;
}

/** Centre of the machine's bed and its printable volume, mm. */
export function bedOf(machine: Preset) {
	const points = (machine.printable_area as string[] | undefined)?.map((p) => p.split('x').map(Number)) ?? [];
	if (!points.length) return { center: { x: 0, y: 0 }, size: { x: Infinity, y: Infinity, z: Infinity } };
	const xs = points.map((p) => p[0]);
	const ys = points.map((p) => p[1]);
	return {
		center: { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 },
		size: { x: Math.max(...xs) - Math.min(...xs), y: Math.max(...ys) - Math.min(...ys), z: Number(machine.printable_height) || Infinity }
	};
}
