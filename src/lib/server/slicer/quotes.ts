/**
 * Accurate quotes, run through OrcaSlicer.
 *
 * FDM: the part is packed into a 3MF with the customer's settings on the
 * object, and Orca runs on it twice at once: a slice for the filament use and
 * print time we price, and an unsliced project export that becomes the file we
 * keep. So the stored 3MF is exactly what was quoted.
 *
 * SLA: a solid part takes its exact mesh volume of resin; a hollowed one, the
 * shell Orca slices with 0% infill. Supports are priced from the overhang area,
 * and the file kept is a Photon Workshop scene (.pwscene) with the resin and
 * layer height set.
 *
 * CNC: the server repeats the configurator's tool-access analysis on the
 * part and prices it with the same estimator, so the quote is the price the
 * customer saw, worked out where it can't be tampered with. The file kept is
 * the customer's own STEP file, which the machine is programmed from.
 *
 * Either way finalizing a quote needs no second upload or slice. Each quote
 * lives in DATA_DIR/quotes/<id>/ until it expires.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '$env/dynamic/private';
import {
	axisModes,
	defaultProfile,
	machiningProfile,
	machiningRates,
	processes,
	processProfiles,
	resinProfile,
	resinQualities,
	type Catalog,
	type Process
} from '$lib/catalog/config';
import { estimateMachining, type MachiningSettings, type PrintCost, type PrintSettings, type ResinSettings } from '$lib/pricing/estimate';
import type { ModelInfo } from '$lib/viewer/analysis';
import { analyzeMachiningAsync } from '$lib/viewer/machining';
import type { Quote } from '$lib/pricing/quote';
import { runOrca, SlicerError } from './orca';
import { bedOf, filamentPreset, machinePreset, processPreset, type Preset } from './presets';
import { buildPwscene, resinProfileName } from './pwscene';
import { objectSettings, parsePrintSettings } from './settings';
import { buildInput3mf, meshVolume, parseStl, type Mesh } from './threemf';

/** How long a quoted price holds, and its file is kept for finalizing. */
const QUOTE_TTL_MS = 24 * 3600_000;
const RECORD_FILE = 'quote.json';

/**
 * The Orca printer that measures SLA resin volume. Only its slicing geometry
 * matters (FDM print time and speeds are ignored), so any printer whose bed
 * holds the vat's build volume will do.
 */
const VOLUME_SLICER = { vendor: 'BBL', printer: 'Bambu Lab X1 Carbon', plate: 'Textured PEI Plate', nozzle: 0.4, layerHeight: 0.2, lineWidth: 0.42 };

export function dataDir() {
	return path.resolve(env.DATA_DIR || 'data');
}

const quotesDir = () => path.join(dataDir(), 'quotes');

export type QuoteRequestBody = {
	name: string;
	processId: string;
	/** Filament or resin product handle. */
	materialId: string;
	/** Shopify variant id of the colour / pigment (the stock id for CNC). */
	colorId: string;
	settings: unknown;
	/** Rotation (deg) and scale applied in the configurator; CNC records it, as the STEP file is kept as uploaded. */
	transform?: unknown;
};

type Rotation = { x: number; y: number; z: number };

/** Kept with a quote: what finalizing it needs. */
export type QuoteRecord = {
	quote: Quote;
	name: string;
	processId: string;
	material: { id: string; name: string; color: string; colorHex: string };
	triangles: number;
	/** The file kept for the order, in the quote's folder. */
	file: string;
} & (
	| {
			kind: 'extrusion';
			settings: PrintSettings;
			/** OrcaSlicer presets it was sliced with. */
			presets: { machine: string; process: string; filaments: string[] };
	  }
	| {
			kind: 'resin';
			settings: ResinSettings;
			/** Photon Workshop resin profile. */
			resinProfile: string;
	  }
	| {
			kind: 'machining';
			settings: MachiningSettings;
			/** "50 × 50 × 20 mm piece", "Ø30 × 100 mm round bar". */
			stock: string;
			setups: number;
			/** How the customer turned the part (degrees, XYZ), to machine it in the orientation that was priced. */
			rotation: Rotation;
	  }
);

/**
 * `model` is the part as a binary STL with the customer's rotation and scale applied;
 * `source` is the original upload (needed for CNC, which keeps the STEP file).
 */
export async function createQuote(body: QuoteRequestBody, model: Uint8Array, catalog: Catalog, source?: File): Promise<Quote> {
	const process = processes.find((p) => p.id === body.processId);
	if (process?.kind === 'extrusion') return createFdmQuote(process, body, model, catalog);
	if (process?.kind === 'resin') return createResinQuote(process, body, model, catalog);
	if (process?.kind === 'machining') return createMachiningQuote(process, body, model, source, catalog);
	throw new SlicerError(process ? `Accurate quotes for ${process.title} aren't available yet.` : 'Unknown manufacturing method.', 400);
}

async function createFdmQuote(process: Process, body: QuoteRequestBody, model: Uint8Array, catalog: Catalog): Promise<Quote> {
	if (!process.slicer) throw new SlicerError(`Accurate quotes for ${process.title} aren't available yet.`, 400);
	const { vendor, printer, plate } = process.slicer;

	const material = catalog.materialCategories.flatMap((c) => c.materials).find((m) => m.id === body.materialId);
	if (!material || (material.requiresEnclosure && !process.enclosed)) throw new SlicerError('That material is not available for this method.', 400);
	const color = material.colors.find((c) => c.id === body.colorId);
	if (!color) throw new SlicerError('That colour is no longer available.', 400);

	const soluble = catalog.supportInterfaces.find((i) => i.id === 'soluble');
	const pva = soluble?.material;
	const settings = parse(() => parsePrintSettings(body.settings, !!pva));
	if (material.nozzles && !material.nozzles.includes(settings.nozzle)) {
		throw new SlicerError(`${material.name} can't be printed with a ${settings.nozzle} mm nozzle. Pick one of: ${material.nozzles.join(', ')} mm.`, 400);
	}
	const useSoluble = settings.supportPlacement !== 'none' && settings.supportInterface === 'soluble';
	const mesh = parse(() => parseStl(model));
	const name = partName(body);

	const machine = await machinePreset(vendor, printer, settings.nozzle);
	checkLayerHeight(machine, settings);
	const bed = bedOf(machine);
	checkFits(mesh, bed.size);
	const filaments = [filamentFor(await filamentPreset(vendor, machine.name, material.slicerPreset ?? material.name), material.density, color.hex)];
	if (useSoluble && pva) filaments.push(filamentFor(await filamentPreset(vendor, machine.name, pva.slicerPreset ?? pva.name), pva.density, pva.hex));
	const print = { ...(await processPreset(vendor, machine.name, settings.layerHeight)), curr_bed_type: plate };

	return inQuoteDir(async (id, dir) => {
		const file = 'project.3mf';
		const stats = await slice(dir, { machine, print, filaments, input: buildInput3mf(mesh, name, objectSettings(settings), bed.center), exportAs: file });

		// Filament 1 is the part (and its supports); filament 2, if any, the soluble interface.
		const partGrams = (stats.cm3[0] ?? 0) * material.density;
		const interfaceGrams = useSoluble && pva ? (stats.cm3[1] ?? 0) * pva.density : 0;
		const profile = processProfiles[process.id] ?? defaultProfile;
		const hours = stats.seconds / 3600;
		const materialCost = partGrams * color.price + interfaceGrams * (soluble?.pricePerGram ?? 0);
		const machineCost = hours * profile.machineRate;
		const quote: Quote = {
			id,
			expiresAt: new Date(Date.now() + QUOTE_TTL_MS).toISOString(),
			grams: partGrams + interfaceGrams,
			// Orca doesn't report support material on its own; only a soluble interface is measured apart.
			supportGrams: interfaceGrams,
			hours,
			layers: stats.layers,
			materialCost,
			machineCost,
			setupFee: profile.setupFee,
			total: materialCost + machineCost + profile.setupFee
		};
		return {
			kind: 'extrusion',
			quote,
			name,
			processId: process.id,
			material: { id: material.id, name: material.name, color: color.name, colorHex: color.hex },
			triangles: mesh.triangles.length / 3,
			file,
			settings,
			presets: { machine: machine.name, process: print.name, filaments: filaments.map((f) => f.name) }
		};
	});
}

async function createResinQuote(process: Process, body: QuoteRequestBody, model: Uint8Array, catalog: Catalog): Promise<Quote> {
	const resin = catalog.resins.find((r) => r.id === body.materialId);
	if (!resin) throw new SlicerError('That resin is not available.', 400);
	const pigment = resin.pigments.find((p) => p.id === body.colorId);
	if (!pigment) throw new SlicerError('That colour is no longer available.', 400);
	const settings = parse(() => parseResinSettings(body.settings));
	const mesh = parse(() => parseStl(model));
	checkFits(mesh, process.bed);
	const name = partName(body);
	const resinName = resinProfileName(resin.name);

	return inQuoteDir(async (id, dir) => {
		const file = 'scene.pwscene';
		await writeFile(path.join(dir, file), buildPwscene(mesh, name, resinName, settings.layerHeight));

		// A solid part takes its exact volume; a hollowed one, the shell Orca slices (never more).
		// Supports are priced from the overhangs, as SLA supports are nothing like FDM ones.
		const solidMl = meshVolume(mesh);
		const partMl = settings.hollow ? Math.min(solidMl, await shellVolume(dir, mesh, name, resin.density)) : solidMl;
		const supportMl = overhangArea(mesh, resinProfile.overhangAngle) * resinProfile.supportMlPerCm2;
		const ml = partMl + supportMl;
		const layers = Math.ceil(mesh.size.z / settings.layerHeight);
		const hours = (layers * resinProfile.secondsPerLayer * resin.exposureFactor) / 3600;
		const materialCost = ml * pigment.price;
		const machineCost = hours * resinProfile.machineRate;
		const quote: Quote = {
			id,
			expiresAt: new Date(Date.now() + QUOTE_TTL_MS).toISOString(),
			ml,
			grams: ml * resin.density,
			supportGrams: supportMl * resin.density,
			hours,
			layers,
			materialCost,
			machineCost,
			setupFee: resinProfile.setupFee,
			total: materialCost + machineCost + resinProfile.setupFee
		};
		return {
			kind: 'resin',
			quote,
			name,
			processId: process.id,
			material: { id: resin.id, name: resin.name, color: pigment.name, colorHex: pigment.hex },
			triangles: mesh.triangles.length / 3,
			file,
			settings,
			resinProfile: resinName
		};
	});
}

async function createMachiningQuote(process: Process, body: QuoteRequestBody, model: Uint8Array, source: File | undefined, catalog: Catalog): Promise<Quote> {
	const stock = catalog.stockMaterials.find((m) => m.id === body.materialId);
	if (!stock) throw new SlicerError('That stock material is not available.', 400);
	const settings = parse(() => parseMachiningSettings(body.settings));
	const mode = axisModes.find((m) => m.id === settings.axes)!;
	const rotation = parse(() => unscaledRotation(body.transform));
	const step = await readStep(source);
	const mesh = parse(() => parseStl(model));
	const name = partName(body);

	// The machine envelope, or for 4-axis the rotary: a bar along X of limited length and swing.
	const { rotary } = machiningProfile;
	checkFits(mesh, settings.axes === 'four' ? { x: rotary.length, y: rotary.diameter, z: rotary.diameter } : process.bed);

	const machining = await analyzeMachiningAsync(unindexed(mesh), () => new Promise((r) => setImmediate(r)));
	if (settings.axes === 'four' && machining.rotaryRadius * 2 > rotary.diameter) {
		throw new SlicerError(`The part needs a ${(machining.rotaryRadius * 2).toFixed(1)} mm bar; the rotary takes up to Ø${rotary.diameter} mm. Use 3-axis or turn the part so its long side runs along X.`, 400);
	}
	const info: ModelInfo = {
		name,
		size: mesh.size,
		volume: meshVolume(mesh),
		surfaceArea: surfaceArea(mesh),
		overhangArea: 0,
		triangles: mesh.triangles.length / 3,
		openEdges: 0,
		fitsBed: true,
		thickness: null,
		machining
	};
	const cost = estimateMachining(info, mode, stock, machiningProfile, machiningRates);

	return inQuoteDir(async (id, dir) => {
		const file = `part.${step.extension}`;
		await writeFile(path.join(dir, file), step.bytes);
		return {
			kind: 'machining',
			quote: { ...cost, id, expiresAt: new Date(Date.now() + QUOTE_TTL_MS).toISOString() },
			name,
			processId: process.id,
			material: { id: stock.id, name: stock.name, color: stock.name, colorHex: stock.color },
			triangles: info.triangles,
			file,
			settings,
			stock: stockLabel(cost.stock!),
			setups: cost.stock!.setups,
			rotation
		};
	});
}

function parseMachiningSettings(input: unknown): MachiningSettings {
	const axes = (input as Record<string, unknown> | null)?.axes;
	if (!axisModes.some((m) => m.id === axes)) throw new Error('Invalid axes.');
	return { axes: axes as MachiningSettings['axes'] };
}

/**
 * The customer's rotation. The STEP file is machined as uploaded, so the part
 * must keep its designed size: a scaled part can't be ordered.
 */
function unscaledRotation(input: unknown): Rotation {
	const t = (input ?? {}) as { rotation?: Partial<Rotation>; scale?: Partial<Rotation> };
	const axes = ['x', 'y', 'z'] as const;
	if (axes.some((k) => Math.abs(Number(t.scale?.[k] ?? 1) - 1) > 1e-6)) {
		throw new Error('CNC parts are machined from your STEP file at its designed size. Reset the scale to 100% to get a quote.');
	}
	const rotation = Object.fromEntries(axes.map((k) => [k, Number(t.rotation?.[k] ?? 0)])) as Rotation;
	if (axes.some((k) => !Number.isFinite(rotation[k]))) throw new Error('Invalid rotation.');
	return rotation;
}

/** The uploaded STEP file, checked to really be one (ISO 10303-21). */
async function readStep(source: File | undefined) {
	const extension = source?.name.match(/\.(step|stp)$/i)?.[1].toLowerCase();
	if (!source || !extension) throw new SlicerError('CNC machining needs a STEP (.step / .stp) file. Export one from your CAD software and upload it.', 400);
	const bytes = new Uint8Array(await source.arrayBuffer());
	const head = new TextDecoder().decode(bytes.subarray(0, 64)).replace(/^\uFEFF/, '').trimStart();
	if (!head.startsWith('ISO-10303-21')) throw new SlicerError("That file isn't a valid STEP file. Re-export it from your CAD software.", 400);
	return { bytes, extension };
}

/** Three corners per triangle, as the machining analysis expects. */
function unindexed(mesh: Mesh) {
	const { vertices: v, triangles: t } = mesh;
	const out = new Float32Array(t.length * 3);
	for (let i = 0; i < t.length; i++) out.set(v.subarray(t[i] * 3, t[i] * 3 + 3), i * 3);
	return out;
}

/** cm² */
function surfaceArea(mesh: Mesh) {
	const { vertices: v, triangles: t } = mesh;
	let area = 0;
	for (let i = 0; i < t.length; i += 3) {
		const a = t[i] * 3;
		const b = t[i + 1] * 3;
		const c = t[i + 2] * 3;
		const ab = [v[b] - v[a], v[b + 1] - v[a + 1], v[b + 2] - v[a + 2]];
		const ac = [v[c] - v[a], v[c + 1] - v[a + 1], v[c + 2] - v[a + 2]];
		area += Math.hypot(ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]) / 2;
	}
	return area / 100;
}

function stockLabel(s: NonNullable<PrintCost['stock']>) {
	const mm = (...values: number[]) => values.map((v) => (Number.isInteger(v) ? String(v) : v.toFixed(1))).join(' × ');
	if (s.kind === 'bar') {
		const section = s.shape === 'round' ? `Ø${mm(s.size)}` : mm(s.size, s.size);
		return `${s.custom ? 'Custom ' : ''}${section} × ${mm(s.length)} mm ${s.shape} bar`;
	}
	return s.custom ? `Custom ${mm(s.x, s.y, s.z)} mm block` : `${mm(s.x, s.y, s.z)} mm piece`;
}

/**
 * Resin a hollowed part takes, ml: Orca slices it as a drained shell of the
 * hollowing wall (walls, top and bottom shells, 0% infill, no supports).
 * Only the slicing geometry matters, so it uses VOLUME_SLICER's printer.
 */
async function shellVolume(dir: string, mesh: Mesh, name: string, density: number) {
	const { vendor, printer, plate, nozzle, layerHeight, lineWidth } = VOLUME_SLICER;
	const machine = await machinePreset(vendor, printer, nozzle);
	const print = { ...(await processPreset(vendor, machine.name, layerHeight)), curr_bed_type: plate };
	const filament = { ...filamentFor(await filamentPreset(vendor, machine.name, 'PLA Basic'), density, '#FFFFFF'), filament_flow_ratio: ['1'] };
	const wall = resinProfile.hollowWall;
	const shells = String(Math.ceil(wall / layerHeight));
	const shape = {
		layer_height: String(layerHeight),
		enable_support: '0',
		sparse_infill_density: '0%',
		wall_loops: String(Math.max(1, Math.round(wall / lineWidth))),
		top_shell_layers: shells,
		bottom_shell_layers: shells
	};
	const stats = await slice(dir, { machine, print, filaments: [filament], input: buildInput3mf(mesh, name, shape, bedOf(machine).center) });
	return stats.cm3[0] ?? 0;
}

/** Run `work` in a fresh quote folder; keep only its record and file. On failure, remove the folder. */
async function inQuoteDir(work: (id: string, dir: string) => Promise<QuoteRecord>): Promise<Quote> {
	const id = randomUUID();
	const dir = path.join(quotesDir(), id);
	await mkdir(dir, { recursive: true });
	sweepExpired();
	try {
		const record = await work(id, dir);
		await writeFile(path.join(dir, RECORD_FILE), JSON.stringify(record));
		const keep = new Set([RECORD_FILE, record.file]);
		await Promise.all((await readdir(dir)).filter((f) => !keep.has(f)).map((f) => rm(path.join(dir, f), { recursive: true, force: true })));
		return record.quote;
	} catch (err) {
		await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch((e) => console.error('Could not remove failed quote', e));
		throw err;
	}
}

type SliceJob = {
	machine: Preset;
	print: Preset;
	filaments: Preset[];
	input: Uint8Array;
	/** Also export the unsliced Orca project under this name. */
	exportAs?: string;
};

/** Slice `input` with the given presets and read the G-code stats; optionally export the project alongside. */
async function slice(dir: string, job: SliceJob): Promise<GcodeStats> {
	const files = { machine: path.join(dir, 'machine.json'), process: path.join(dir, 'process.json'), input: path.join(dir, 'input.3mf') };
	const filamentFiles = job.filaments.map((_, i) => path.join(dir, `filament_${i + 1}.json`));
	await Promise.all([
		writeFile(files.machine, JSON.stringify(job.machine)),
		writeFile(files.process, JSON.stringify(job.print)),
		...job.filaments.map((f, i) => writeFile(filamentFiles[i], JSON.stringify(f))),
		writeFile(files.input, job.input)
	]);

	const presets = ['--load-settings', `${files.machine};${files.process}`, '--load-filaments', filamentFiles.join(';')];
	// Wait for both, so a failure never leaves the other writing into a folder being deleted.
	const runs = await Promise.allSettled([
		runOrca(['--slice', '0', ...presets, '--outputdir', path.join(dir, 'slice'), files.input]),
		job.exportAs ? runOrca([...presets, '--outputdir', dir, '--export-3mf', job.exportAs, files.input]) : Promise.resolve()
	]);
	for (const run of runs) if (run.status === 'rejected') throw run.reason;
	return readGcodeStats(path.join(dir, 'slice', 'plate_1.gcode'));
}

function partName(body: QuoteRequestBody) {
	return String(body.name ?? '').trim().slice(0, 120) || 'Part';
}

function checkFits(mesh: Mesh, bed: { x: number; y: number; z: number }) {
	if (mesh.size.x > bed.x || mesh.size.y > bed.y || mesh.size.z > bed.z) {
		throw new SlicerError(`The part doesn't fit the ${+bed.x.toFixed(1)} × ${+bed.y.toFixed(1)} × ${+bed.z.toFixed(1)} mm build volume.`, 400);
	}
}

function parseResinSettings(input: unknown): ResinSettings {
	const s = (input ?? {}) as Record<string, unknown>;
	if (typeof s.layerHeight !== 'number' || !resinQualities.some((q) => q.layerHeight === s.layerHeight)) throw new Error('Invalid layerHeight.');
	if (typeof s.hollow !== 'boolean') throw new Error('Invalid hollow.');
	return { layerHeight: s.layerHeight, hollow: s.hollow };
}

/**
 * Downward-facing area that needs supports, cm²: faces leaning out more than
 * `angle` degrees from vertical, except those resting on the build plate.
 * Matches the configurator's overhang view.
 */
function overhangArea(mesh: Mesh, angle: number) {
	const { vertices: v, triangles: t } = mesh;
	const threshold = Math.sin((angle * Math.PI) / 180);
	let area = 0;
	for (let i = 0; i < t.length; i += 3) {
		const a = t[i] * 3;
		const b = t[i + 1] * 3;
		const c = t[i + 2] * 3;
		if (Math.min(v[a + 2], v[b + 2], v[c + 2]) < 0.3) continue;
		const ab = [v[b] - v[a], v[b + 1] - v[a + 1], v[b + 2] - v[a + 2]];
		const ac = [v[c] - v[a], v[c + 1] - v[a + 1], v[c + 2] - v[a + 2]];
		const n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
		const len = Math.hypot(n[0], n[1], n[2]);
		if (len > 0 && -n[2] / len > threshold) area += len / 2;
	}
	return area / 100;
}

/** A live quote and the path of the file kept for it, or null if it's unknown or expired. */
export async function getQuote(id: string): Promise<{ record: QuoteRecord; dir: string; projectFile: string } | null> {
	if (!/^[0-9a-f-]{36}$/.test(id)) return null;
	const dir = path.join(quotesDir(), id);
	try {
		const record: QuoteRecord = JSON.parse(await readFile(path.join(dir, RECORD_FILE), 'utf8'));
		if (Date.parse(record.quote.expiresAt) < Date.now()) return null;
		return { record, dir, projectFile: path.join(dir, record.file) };
	} catch {
		return null;
	}
}

function parse<T>(read: () => T): T {
	try {
		return read();
	} catch (err) {
		throw new SlicerError((err as Error).message, 400);
	}
}

/** The printer's allowed layer heights for this nozzle (e.g. Draft layers are too tall for a 0.2 mm nozzle). */
function checkLayerHeight(machine: Preset, settings: PrintSettings) {
	const max = Number((machine.max_layer_height as string[] | undefined)?.[0]);
	const min = Number((machine.min_layer_height as string[] | undefined)?.[0]);
	if (max && settings.layerHeight > max) {
		throw new SlicerError(`${settings.layerHeight} mm layers are too tall for a ${settings.nozzle} mm nozzle (${max} mm at most). Pick a finer quality or a larger nozzle.`, 400);
	}
	if (min && settings.layerHeight < min) {
		throw new SlicerError(`${settings.layerHeight} mm layers are too fine for a ${settings.nozzle} mm nozzle (${min} mm at least). Pick a coarser quality or a smaller nozzle.`, 400);
	}
}

/** The store's colour and density on the slicer's filament, so the project shows the right colour and weights. */
function filamentFor(preset: Preset, density: number, hex: string): Preset {
	return { ...preset, filament_colour: [hex], filament_density: [String(density)] };
}

type GcodeStats = { seconds: number; layers: number; cm3: number[] };

/**
 * Print time and layer count from the G-code header, filament volume per
 * extruder from its last lines. The model printing time leaves out the
 * printer's start routine, which the setup fee covers.
 */
async function readGcodeStats(file: string): Promise<GcodeStats> {
	const handle = await open(file, 'r');
	try {
		const { size } = await handle.stat();
		const head = Buffer.alloc(Math.min(size, 8192));
		await handle.read(head, 0, head.length, 0);
		const tail = Buffer.alloc(Math.min(size, 16384));
		await handle.read(tail, 0, tail.length, size - tail.length);
		const text = `${head}\n${tail}`;

		const time = /; model printing time: ([^;\n]+)/.exec(text)?.[1] ?? /; total estimated time: ([^;\n]+)/.exec(text)?.[1];
		const layers = Number(/; total layer number: (\d+)/.exec(text)?.[1]);
		const cm3 = /; filament used \[cm3\] = ([^\n]+)/.exec(text)?.[1].split(',').map(Number);
		if (!time || !cm3?.length) throw new SlicerError('The slicer failed on this model.', 500, `Unexpected G-code stats in ${file}`);
		return { seconds: duration(time), layers: layers || 0, cm3 };
	} finally {
		await handle.close();
	}
}

/** "1d 2h 3m 4s" → seconds. */
function duration(text: string) {
	const unit: Record<string, number> = { d: 86400, h: 3600, m: 60, s: 1 };
	let seconds = 0;
	for (const [, n, u] of text.matchAll(/(\d+)\s*([dhms])/g)) seconds += Number(n) * unit[u];
	return seconds;
}

let lastSweep = 0;

/** Delete expired quotes, at most once an hour. */
function sweepExpired() {
	if (Date.now() - lastSweep < 3600_000) return;
	lastSweep = Date.now();
	(async () => {
		for (const id of await readdir(quotesDir()).catch(() => [])) {
			const dir = path.join(quotesDir(), id);
			const modified = (await stat(dir).catch(() => null))?.mtimeMs ?? Date.now();
			if (Date.now() - modified > QUOTE_TTL_MS + 3600_000) await rm(dir, { recursive: true, force: true });
		}
	})().catch((err) => console.error('Could not clean up expired quotes', err));
}
