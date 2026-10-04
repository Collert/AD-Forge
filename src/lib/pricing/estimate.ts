import type {
	AxisMode,
	FuzzySkinMode,
	MachiningProfile as MachineProfile,
	StockBar,
	StockMaterial,
	StockPiece,
	InfillPattern,
	Material,
	ProcessProfile,
	Resin,
	ResinProfile,
	SupportInterface,
	SupportPlacement
} from '$lib/catalog/config';
import type { ModelInfo } from '$lib/viewer/analysis';
import { planSetups } from '$lib/viewer/machining';

/** Every FDM slicer setting the configurator exposes (simple + advanced). */
export type PrintSettings = {
	// Layers & nozzle
	/** mm */
	layerHeight: number;
	/** mm */
	nozzle: number;
	// Walls & shells
	wallLoops: number;
	topShells: number;
	bottomShells: number;
	wallSequence: string;
	detectThinWalls: boolean;
	// Infill
	/** 0–100 */
	infill: number;
	infillPattern: string;
	// Supports
	supportPlacement: string;
	/** Degrees from vertical. */
	overhangAngle: number;
	supportInterface: string;
	// Dimensional accuracy, mm
	xyHoleCompensation: number;
	xyContourCompensation: number;
	// Surface finish
	ironing: boolean;
	fuzzySkin: string;
};

/** The catalog records the settings' ids point at. */
export type ResolvedOptions = {
	material: Material;
	infillPattern: InfillPattern;
	supportPlacement: SupportPlacement;
	supportInterface: SupportInterface;
	fuzzySkin: FuzzySkinMode;
};

/** SLA settings the configurator exposes. */
export type ResinSettings = {
	/** mm */
	layerHeight: number;
	hollow: boolean;
};

/** CNC settings the configurator exposes. */
export type MachiningSettings = { axes: AxisMode['id'] };

export type PrintCost = {
	/** Liquid resin used, ml (resin processes only). */
	ml?: number;
	/** Raw stock and how much of it is cut away (machining only). */
	stock?: StockSize & { cm3: number; removedCm3: number; setups: number };
	grams: number;
	supportGrams: number;
	hours: number;
	layers: number;
	materialCost: number;
	machineCost: number;
	setupFee: number;
	total: number;
};

/**
 * Rough, instant cost estimate from mesh geometry alone — no slicing.
 *
 * - Shell: surface area × the average of wall thickness (loops × line width)
 *   and skin thickness (top/bottom shells × layer height).
 * - Core: remaining volume × infill density × pattern material factor.
 * - Supports: overhang area × grams/cm² × placement coverage, with an
 *   optional interface share priced as a separate material.
 * - Time: constant extrusion throughput scaled by nozzle, layer height,
 *   material and pattern, plus per-layer overhead and finish multipliers.
 */
export function estimatePrint(
	model: ModelInfo,
	settings: PrintSettings,
	options: ResolvedOptions,
	profile: ProcessProfile
): PrintCost {
	const { material, infillPattern, supportPlacement, supportInterface, fuzzySkin } = options;

	const lineWidth = settings.nozzle * profile.lineWidthFactor;
	const wallMm = settings.wallLoops * lineWidth;
	const skinMm = ((settings.topShells + settings.bottomShells) / 2) * settings.layerHeight;
	const shellMm = (wallMm + skinMm) / 2;

	const shellCm3 = Math.min(model.volume, (model.surfaceArea * shellMm) / 10);
	const coreCm3 = model.volume - shellCm3;
	const infillFraction = Math.min(1, (settings.infill / 100) * infillPattern.materialFactor);
	const partGrams = (shellCm3 + coreCm3 * infillFraction) * material.density;

	const supportGrams = model.overhangArea * profile.supportGramsPerCm2 * supportPlacement.coverage;
	const interfaceGrams = supportInterface.pricePerGram === null ? 0 : supportGrams * profile.supportInterfaceShare;
	const grams = partGrams + supportGrams;

	const { baseFlow } = profile;
	const throughput =
		baseFlow.gramsPerHour *
		(settings.nozzle / baseFlow.nozzle) *
		(settings.layerHeight / baseFlow.layerHeight) *
		material.speedFactor *
		infillPattern.speedFactor;
	const finishFactor = fuzzySkin.timeFactor * (settings.ironing ? profile.ironingTimeFactor : 1);
	const layers = Math.ceil(model.size.z / settings.layerHeight);
	const hours = (grams / throughput) * finishFactor + (layers * profile.layerChangeSeconds) / 3600;

	const materialCost =
		(grams - interfaceGrams) * material.pricePerGram +
		interfaceGrams * (supportInterface.pricePerGram ?? material.pricePerGram);
	const machineCost = hours * profile.machineRate;

	return {
		grams,
		supportGrams,
		hours,
		layers,
		materialCost,
		machineCost,
		setupFee: profile.setupFee,
		total: materialCost + machineCost + profile.setupFee
	};
}

/** Resin needed for the part itself (no supports), ml: a drained shell when hollow, else the full volume. */
export function resinPartMl(model: ModelInfo, hollow: boolean, profile: ResinProfile) {
	return hollow ? Math.min(model.volume, (model.surfaceArea * profile.hollowWall) / 10) : model.volume;
}

/**
 * Rough, instant SLA estimate. The whole layer cures at once, so time is
 * layer count × per-layer cycle regardless of footprint; cost is resin used
 * (part + supports) plus machine time and a flat prep / wash / cure fee.
 */
export function estimateResin(
	model: ModelInfo,
	settings: ResinSettings,
	resin: Resin,
	profile: ResinProfile
): PrintCost {
	const supportMl = model.overhangArea * profile.supportMlPerCm2;
	const ml = resinPartMl(model, settings.hollow, profile) + supportMl;
	const layers = Math.ceil(model.size.z / settings.layerHeight);
	const hours = (layers * profile.secondsPerLayer * resin.exposureFactor) / 3600;
	const materialCost = ml * resin.pricePerMl;
	const machineCost = hours * profile.machineRate;

	return {
		ml,
		grams: ml * resin.density,
		supportGrams: supportMl * resin.density,
		hours,
		layers,
		materialCost,
		machineCost,
		setupFee: profile.setupFee,
		total: materialCost + machineCost + profile.setupFee
	};
}

export type StockSize =
	/** A standard pre-cut piece (`custom: false`) or an oversize block cut to order. */
	| { kind: 'block'; x: number; y: number; z: number; custom: boolean }
	/** A 4-axis bar along X: `size` is the diameter (round) or side (square). */
	| { kind: 'bar'; shape: 'round' | 'square'; size: number; length: number; custom: boolean };

/** Footprint (with clamping margin) and thickness a 3-axis part needs from its stock, mm. */
export function stockNeeded(model: ModelInfo, profile: MachineProfile) {
	const m = profile.stockMargin;
	return { x: model.size.x + 2 * m, y: model.size.y + 2 * m, z: model.size.z };
}

/**
 * Greedy pick: the smallest pre-cut piece (by volume, then price) that holds
 * the part's footprint plus margin either way round, and is at least as thick
 * as the part. Null when nothing in stock is big enough.
 */
export function pickStockPiece(model: ModelInfo, material: StockMaterial, profile: MachineProfile): StockPiece | null {
	const need = stockNeeded(model, profile);
	const fits = (p: StockPiece) =>
		p.z >= need.z && ((p.x >= need.x && p.y >= need.y) || (p.x >= need.y && p.y >= need.x));
	const bySize = [...material.pieces].sort((a, b) => a.x * a.y * a.z - b.x * b.y * b.z || a.price - b.price);
	return bySize.find(fits) ?? null;
}

/**
 * What a 4-axis part needs from a bar held along X: its length plus margin at
 * each end, a round section reaching its furthest point from the axis (measured
 * once tool access has run, else the bounding-box corner), or a square section
 * holding its Y/Z extents — all plus margin.
 */
export function barNeeded(model: ModelInfo, profile: MachineProfile) {
	const m = profile.stockMargin;
	const radius = model.machining?.rotaryRadius ?? Math.hypot(model.size.y, model.size.z) / 2;
	return {
		length: model.size.x + 2 * m,
		diameter: 2 * (radius + m),
		side: Math.max(model.size.y, model.size.z) + 2 * m
	};
}

/** Greedy pick, as for pieces: the smallest bar (by volume, then price) that holds the part and fits the rotary. */
export function pickStockBar(model: ModelInfo, material: StockMaterial, profile: MachineProfile): StockBar | null {
	const need = barNeeded(model, profile);
	const { rotary } = profile;
	const volume = (b: StockBar) => (b.shape === 'round' ? Math.PI * (b.size / 2) ** 2 : b.size * b.size) * b.length;
	const fits = (b: StockBar) => {
		const section = b.shape === 'round' ? b.size >= need.diameter : b.size >= need.side;
		const swings = (b.shape === 'round' ? b.size : b.size * Math.SQRT2) <= rotary.diameter;
		return section && swings && b.length >= need.length && b.length <= rotary.length;
	};
	return [...material.bars].sort((a, b) => volume(a) - volume(b) || a.price - b.price).find(fits) ?? null;
}

/**
 * Raw stock for a job and what it costs: the smallest standard piece (3-axis)
 * or bar (4-axis) that holds the part, charged in full — or, when none is big
 * enough, a block or round bar cut to order at the material's $/cm³.
 */
export function stockFor(
	model: ModelInfo,
	axes: AxisMode['id'],
	material: StockMaterial,
	profile: MachineProfile
): StockSize & { cm3: number; price: number } {
	const m = profile.stockMargin;
	if (axes === 'three') {
		const piece = pickStockPiece(model, material, profile);
		if (piece) return { kind: 'block', x: piece.x, y: piece.y, z: piece.z, custom: false, cm3: (piece.x * piece.y * piece.z) / 1000, price: piece.price };
		const need = stockNeeded(model, profile);
		const cm3 = (need.x * need.y * need.z) / 1000;
		return { kind: 'block', ...need, custom: true, cm3, price: cm3 * material.pricePerCm3 };
	}
	const bar = pickStockBar(model, material, profile);
	if (bar) {
		const section = bar.shape === 'round' ? Math.PI * (bar.size / 2) ** 2 : bar.size * bar.size;
		return { kind: 'bar', shape: bar.shape, size: bar.size, length: bar.length, custom: false, cm3: (section * bar.length) / 1000, price: bar.price };
	}
	const need = barNeeded(model, profile);
	const cm3 = (Math.PI * (need.diameter / 2) ** 2 * need.length) / 1000;
	return { kind: 'bar', shape: 'round', size: need.diameter, length: need.length, custom: true, cm3, price: cm3 * material.pricePerCm3 };
}

/**
 * mm³ the cutter actually turns into chips — not the whole stock. On 3-axis
 * the part is cut out of its piece with one slot around its outline (the rest
 * stays scrap), plus pockets and steps inside the outline and facing the top
 * down to the part. On 4-axis everything around the part along its length is
 * turned away, plus a parting cut.
 */
export function machinedVolume(model: ModelInfo, stock: StockSize, profile: MachineProfile) {
	const part = model.volume * 1000;
	const { size } = model;
	const tool = profile.standardTool;
	if (stock.kind === 'bar') {
		const section = stock.shape === 'round' ? Math.PI * (stock.size / 2) ** 2 : stock.size * stock.size;
		return Math.max(0, section * size.x - part) + section * tool;
	}
	const outline = model.machining?.footprint ?? { area: size.x * size.y, perimeter: 2 * (size.x + size.y) };
	const inside = Math.max(0, outline.area * size.z - part);
	const facing = (size.x + 2 * profile.stockMargin) * (size.y + 2 * profile.stockMargin) * Math.max(0, stock.z - size.z);
	const cutOut = outline.perimeter * tool * stock.z;
	return inside + facing + cutOut;
}

/**
 * Finishing minutes by surface type: walls are finished by the side of the
 * cutter (a pass per cutting length of height), flat floors at a wide
 * stepover, curved and sloped faces at the fine 3D stepover.
 */
export function finishingMinutes(model: ModelInfo, mode: AxisMode) {
	const total = model.surfaceArea * 100;
	// Until tool access has measured them, assume a typical prismatic split.
	const s = model.machining?.surfaces ?? { walls: total * 0.4, flats: total * 0.2, curved: total * 0.1 };
	const wallPasses = s.walls / Math.max(1, Math.min(model.size.z, mode.wallPassHeight));
	const path = wallPasses + s.flats / mode.floorStepover + s.curved / mode.stepover;
	return (path / mode.finishFeed) * mode.finishOverhead;
}

/**
 * Rough, instant CNC estimate (refined from the backend's STEP-based model,
 * minus its per-hole penalty, which needs B-rep faces):
 *
 * - Roughing: the volume actually machined (see `machinedVolume`) at the
 *   mode's removal rate for the material.
 * - Finishing: by surface type (see `finishingMinutes`).
 * - Setup: per-setup time and fee, times the fewest setups (flips to other
 *   sides of the stock, or rotary end work) that reach every surface.
 */
export function estimateMachining(
	model: ModelInfo,
	mode: AxisMode,
	material: StockMaterial,
	profile: MachineProfile,
	rates: { machineRate: number }
): PrintCost {
	const stock = stockFor(model, mode.id, material, profile);
	const removedCm3 = machinedVolume(model, stock, profile) / 1000;
	const setups = model.machining ? planSetups(model.machining, mode.id, profile.hiddenMinArea, profile.hiddenMinShare).setups : 1;

	const roughingMin = (removedCm3 * 1000) / mode.removalRate[material.group];
	const minutes = roughingMin + finishingMinutes(model, mode) + mode.setupMinutes * setups;
	const hours = minutes / 60;

	const materialCost = stock.price;
	const machineCost = hours * rates.machineRate;
	const setupFee = setupFeeFor(mode, setups);

	return {
		stock: { ...stock, removedCm3, setups },
		grams: model.volume * material.density,
		supportGrams: 0,
		hours,
		layers: 0,
		materialCost,
		machineCost,
		setupFee,
		total: materialCost + machineCost + setupFee
	};
}

/** The first setup at its full fee, every further one at the additional-setup fee. */
export function setupFeeFor(mode: AxisMode, setups: number) {
	return mode.firstSetupFee + mode.additionalSetupFee * Math.max(0, setups - 1);
}
