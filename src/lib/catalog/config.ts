/**
 * Shop-floor configuration: processes, machine profiles and slicer options.
 *
 * Materials, colours, resins and CNC stock come from the Shopify store (see
 * `$lib/server/catalog`) as a `Catalog`; the types here are the shapes the UI
 * and the estimator consume.
 */
import type { BedSize } from '$lib/viewer/analysis';

export type Process = {
	id: string;
	/** Which configurator the process uses: extruded filament, liquid resin, or neither yet. */
	kind: 'extrusion' | 'resin' | 'machining' | 'other';
	title: string;
	/** Short tag for badges and filters, e.g. "FDM". */
	badge: string;
	subtitle: string;
	icon: string;
	bed: BedSize;
	bedLabel: string;
	/** Thinnest wall / pin the process reliably resolves, mm. FDM derives it from the nozzle instead. */
	minFeature?: number;
	/** Extrusion printers with a heated enclosure; open-frame ones only get filaments that don't need one. */
	enclosed?: boolean;
	/**
	 * OrcaSlicer system printer the accurate quote slices for: the profile vendor folder, the
	 * printer model (its machine presets are named "<printer> <nozzle> nozzle") and the build
	 * plate it prints on (Orca's `curr_bed_type`). Extrusion processes without one can't be quoted yet.
	 */
	slicer?: { vendor: string; printer: string; plate: string };
	/** Multiplier on the volume tiers' dollars off (CNC parts get twice the discount). */
	tierScale?: number;
	comingSoon?: boolean;
};

/** Machine-side parameters the rough estimator uses for a process. */
export type ProcessProfile = {
	/** $ per machine hour. */
	machineRate: number;
	/** Flat $ per order line for slicing and bed prep. */
	setupFee: number;
	/** Extrusion line width as a multiple of nozzle diameter. */
	lineWidthFactor: number;
	/** Support material per cm² of overhang, grams. */
	supportGramsPerCm2: number;
	/** Share of support mass printed as interface layers. */
	supportInterfaceShare: number;
	/** Print-time multiplier when ironing top surfaces. */
	ironingTimeFactor: number;
	/** Seconds lost per layer change (travel, z-hop, cooling). */
	layerChangeSeconds: number;
	/** Extrusion throughput (g/h) at the reference nozzle and layer height. */
	baseFlow: { gramsPerHour: number; nozzle: number; layerHeight: number };
};

/** A colour variant of a store product. */
export type ColorOption = {
	/** Shopify variant id. */
	id: string;
	name: string;
	hex: string;
	/** $ per unit of the product (gram of filament, ml of resin). */
	price: number;
	/** On hand; otherwise orderable on backorder. */
	inStock: boolean;
};

/** An FDM filament (a Shopify product priced per gram). */
export type Material = {
	/** Product handle. */
	id: string;
	label: string;
	name: string;
	/** g/cm³ */
	density: number;
	/** $ per gram of the cheapest colour; see `colors` for each one's price. */
	pricePerGram: number;
	/** Print speed relative to the process baseline (TPU is slow, PLA is 1). */
	speedFactor: number;
	specs: string;
	inStock: boolean;
	/** Needs a heated enclosure, so open-frame printers can't run it. */
	requiresEnclosure: boolean;
	colors: ColorOption[];
	datasheetUrl?: string;
	/** Nozzle sizes (mm) the filament is approved for, from `custom.approved_nozzles`; unset allows every size. */
	nozzles?: number[];
	/**
	 * OrcaSlicer filament preset name without its printer suffix (e.g. "Bambu PETG HF"), from the
	 * product's `custom.orca_filament` metafield. Unset: matched from the product title.
	 */
	slicerPreset?: string;
};

/** A Shopify collection of filaments. */
export type MaterialCategory = { id: string; label: string; materials: Material[] };
export type QualityOption = { id: string; label: string; layerHeight: number; note: string };
export type InfillPreset = { value: number; label: string };
export type NozzleOption = { size: number; note: string };
/** A volume tier: `amountOff` dollars off every unit (times the process's `tierScale`) from `minQty` units. */
export type PriceTier = { label: string; minQty: number; amountOff: number };
export type ChoiceOption = { id: string; label: string; note: string };
export type InfillPattern = ChoiceOption & {
	/** Material used relative to grid at the same density. */
	materialFactor: number;
	/** Print speed relative to grid. */
	speedFactor: number;
};
export type SupportPlacement = ChoiceOption & {
	/** Share of overhang area that actually gets support. */
	coverage: number;
};
export type SupportInterface = ChoiceOption & {
	/** $ per gram of interface material; null = same as the part. */
	pricePerGram: number | null;
	/** A separate interface material: its density (g/cm³) and slicer preset, as on `Material`. */
	material?: Pick<Material, 'density' | 'slicerPreset'> & { name: string; hex: string };
};
/** A photopolymer resin for SLA. */
export type Resin = {
	id: string;
	label: string;
	name: string;
	/** g/ml */
	density: number;
	/** $ per ml of the cheapest pigment; see `pigments` for each one's price. */
	pricePerMl: number;
	/** Layer exposure time relative to standard resin. */
	exposureFactor: number;
	tensile: string;
	elongation: string;
	heatDeflect: string;
	pigments: ColorOption[];
	inStock: boolean;
};
export type ShellStrategy = ChoiceOption & { hollow: boolean };

/** Machine-side parameters the rough resin estimator uses. */
export type ResinProfile = {
	/** $ per machine hour. */
	machineRate: number;
	/** Flat $ per order line: platform prep, IPA wash and UV post-cure. */
	setupFee: number;
	/** Exposure + peel + lift per layer with standard resin. */
	secondsPerLayer: number;
	/** Support resin per cm² of overhang, ml. */
	supportMlPerCm2: number;
	/** Degrees from vertical beyond which downward faces get supports. */
	overhangAngle: number;
	/** Wall thickness left when hollowing, mm. */
	hollowWall: number;
};

export type StockGroup = 'metal' | 'plastic' | 'composite' | 'wood';

/** A pre-cut piece of stock: footprint (either way round on the table) and thickness, in mm. */
export type StockPiece = { x: number; y: number; z: number; /** $ for the whole piece. */ price: number; /** Shopify variant id. */ variantId: string };

/** Pre-cut bar stock for the 4th axis, held along X: round (diameter) or square (side), in mm. */
export type StockBar = {
	shape: 'round' | 'square';
	/** Diameter, or side of the square. */
	size: number;
	length: number;
	price: number;
	/** Shopify variant id. */
	variantId: string;
};

/** Raw stock for CNC machining: one material in one colour, gathered from its sheet, block and bar products. */
export type StockMaterial = {
	id: string;
	label: string;
	name: string;
	group: StockGroup;
	/** g/cm³ */
	density: number;
	/** Pre-cut pieces we keep for 3-axis jobs; the smallest one that fits is used and charged in full. */
	pieces: StockPiece[];
	/** Pre-cut round and square bars for 4-axis jobs, picked the same way. */
	bars: StockBar[];
	/** $ per cm³ for stock cut to order when no standard piece or bar fits. */
	pricePerCm3: number;
	/** Preview colour. */
	color: string;
	specs: string;
	inStock: boolean;
};

export type AxisMode = ChoiceOption & {
	id: 'three' | 'four';
	/** $ for the first setup (fixturing, probing, zeroing, CAM). */
	firstSetupFee: number;
	/** $ for each further setup (flipping or re-clamping the same job). */
	additionalSetupFee: number;
	/** Minutes per setup. */
	setupMinutes: number;
	/** Material removal rate (mm³/min) by stock group. */
	removalRate: Record<StockGroup, number>;
	/** Finishing pass feed, mm/min. */
	finishFeed: number;
	/** Finishing stepover on curved / sloped faces (3D finishing), mm. */
	stepover: number;
	/** Finishing stepover on flat floors, mm (~40% of the 3.175 mm end mill). */
	floorStepover: number;
	/** Wall height the cutter's side finishes in one pass, mm (its cutting length). */
	wallPassHeight: number;
	/** Extra finishing time from continuous rotary moves. */
	finishOverhead: number;
};

export type ToolKind = 'flat' | 'long' | 'ball' | 'single-flute' | 'v-bit' | 'drill' | 'corn' | 'thread-mill' | 'chamfer';

/** A cutter in the tool kit. */
export type CuttingTool = {
	kind: ToolKind;
	/** mm (for V-bits, the tip width). */
	diameter: number;
	/** Cutting length, mm — how deep it can reach into a pocket. */
	reach?: number;
	/** e.g. the V angle or thread size. */
	label?: string;
};

/** Machine constants for the CNC estimator and checks (Makera Z1, 150 W spindle). Fixed, not from the API. */
export type MachiningProfile = {
	/** Stock left around the part on every side of the footprint for clamping / tabs, mm. */
	stockMargin: number;
	/** Largest round bar the 4th axis takes, and its usable length, mm. */
	rotary: { diameter: number; length: number };
	/** The default end mill, mm. Internal vertical corners come out with its radius. */
	standardTool: number;
	tools: CuttingTool[];
	/** Unreachable surface worth flagging: at least this many mm² and this share of the part's surface; less is ray-test noise in tight corners. */
	hiddenMinArea: number;
	hiddenMinShare: number;
};

export type FuzzySkinMode = ChoiceOption & { timeFactor: number };
export type NumberRange = { min: number; max: number; step: number };

export const processes: Process[] = [
	{ id: 'fdm', kind: 'extrusion', badge: 'FDM', title: 'FDM 3D Printing', subtitle: 'Rapid Engineering Grade', icon: 'layers', bed: { x: 255, y: 255, z: 255 }, bedLabel: 'Bed', enclosed: true, slicer: { vendor: 'BBL', printer: 'Bambu Lab X1 Carbon', plate: 'Textured PEI Plate' } },
	{ id: 'large-fdm', kind: 'extrusion', badge: 'Large FDM', title: 'Large-Scale FDM', subtitle: 'Build vol up to 450mm', icon: 'view_in_ar', bed: { x: 450, y: 450, z: 450 }, bedLabel: 'Bed', enclosed: false },
	{ id: 'sla', kind: 'resin', badge: 'SLA', title: 'SLA Resin', subtitle: 'Ultra-smooth 25µm', icon: 'opacity', bed: { x: 150, y: 87, z: 160 }, bedLabel: 'Vat', minFeature: 0.3 },
	{ id: 'cnc', kind: 'machining', badge: 'CNC', title: 'CNC Machining', subtitle: 'Metals, plastic & wood', icon: 'precision_manufacturing', bed: { x: 200, y: 200, z: 100 }, bedLabel: 'Envelope', minFeature: 1, tierScale: 2 },
	{ id: 'pcb', kind: 'other', badge: 'PCB', title: 'PCB Fab', subtitle: '1 & 2 layers', icon: 'developer_board', bed: { x: 400, y: 400, z: 5 }, bedLabel: 'Panel', comingSoon: true },
	{ id: 'laser', kind: 'other', badge: 'Laser', title: 'Laser Engraving', subtitle: 'CO2 & Fiber Beds', icon: 'flare', bed: { x: 600, y: 400, z: 20 }, bedLabel: 'Bed', comingSoon: true }
];

const fdmProfile: ProcessProfile = {
	machineRate: 4,
	setupFee: 5,
	lineWidthFactor: 1.125,
	supportGramsPerCm2: 0.25,
	supportInterfaceShare: 0.15,
	ironingTimeFactor: 1.12,
	layerChangeSeconds: 6,
	baseFlow: { gramsPerHour: 14, nozzle: 0.4, layerHeight: 0.2 }
};

/** Estimator profiles by process id; processes without one fall back to `defaultProfile`. */
/** Where to send parts with details too fine for the nozzle. */
export const fineDetailProcessId = 'sla';

/** Surface area (mm²) of too-thin features worth flagging; less is chamfer tips and stray slivers. */
export const fineDetailMinArea = 2;

/** Triangle count above which a mesh is slow to preview and quote, and gets a manual review before its first print. */
export const largeMeshTriangles = 500_000;

export const processProfiles: Record<string, ProcessProfile> = {
	fdm: fdmProfile,
	'large-fdm': { ...fdmProfile, baseFlow: { ...fdmProfile.baseFlow, gramsPerHour: 30 } }
};

export const defaultProfile = fdmProfile;

export const qualities: QualityOption[] = [
	{ id: 'draft', label: 'Draft', layerHeight: 0.28, note: 'Speed Optimized' },
	{ id: 'standard', label: 'Standard', layerHeight: 0.2, note: 'Recommended' },
	{ id: 'fine', label: 'Fine', layerHeight: 0.12, note: 'Ultra Smooth' }
];

export const infillPresets: InfillPreset[] = [
	{ value: 15, label: '15% Cosmetic' },
	{ value: 30, label: '30% Functional' },
	{ value: 60, label: '60% Heavy-Duty' },
	{ value: 100, label: '100% Solid' }
];

export const infillRange = { min: 5, max: 100, step: 1 };

export const nozzles: NozzleOption[] = [
	{ size: 0.2, note: 'Fine Detail' },
	{ size: 0.4, note: 'Standard' },
	{ size: 0.6, note: 'Engineering' },
	{ size: 0.8, note: 'Fast & Strong' }
];

export const infillPatterns: InfillPattern[] = [
	{ id: 'gyroid', label: 'Gyroid', note: 'Isotropic strength & flexibility', materialFactor: 1, speedFactor: 0.85 },
	{ id: 'grid', label: 'Grid', note: 'Fast general purpose', materialFactor: 1, speedFactor: 1 },
	{ id: 'cubic', label: 'Cubic', note: 'Load-bearing compression', materialFactor: 1, speedFactor: 0.95 },
	{ id: 'triangles', label: 'Triangles', note: 'Rigid planar strength', materialFactor: 1, speedFactor: 0.95 },
	{ id: 'lightning', label: 'Lightning', note: 'Only supports top skins; fastest, not structural', materialFactor: 0.45, speedFactor: 1.2 }
];

export const wallLoopOptions = [1, 2, 3, 4, 5, 6];
export const shellCountRange: NumberRange = { min: 0, max: 12, step: 1 };

export const wallSequences: ChoiceOption[] = [
	{ id: 'inner-outer', label: 'Inner / Outer', note: 'Cleaner overhangs' },
	{ id: 'outer-inner', label: 'Outer / Inner', note: 'Better dimensional accuracy' }
];

export const supportPlacements: SupportPlacement[] = [
	{ id: 'none', label: 'None', note: 'Overhangs print unsupported', coverage: 0 },
	{ id: 'build-plate', label: 'Build Plate Only', note: 'Keeps internal holes clean', coverage: 0.6 },
	{ id: 'everywhere', label: 'Everywhere', note: 'Supports every overhang', coverage: 1 }
];

export const overhangRange: NumberRange = { min: 30, max: 70, step: 1 };

/** Support interface options; the soluble one is offered (at its price) only while the store sells `solubleSupportHandle`. */
export const supportInterfaceOptions = {
	same: { id: 'same', label: 'Same material', note: 'Standard breakaway supports', pricePerGram: null } satisfies SupportInterface,
	soluble: { id: 'soluble', label: 'Soluble PVA interface', note: 'Dissolves in water; cleanest underside' }
};

/** Store product (handle) printed as the soluble support interface. */
export const solubleSupportHandle = 'pva';

export const compensationRange: NumberRange = { min: -0.5, max: 0.5, step: 0.01 };

export const fuzzySkinModes: FuzzySkinMode[] = [
	{ id: 'none', label: 'None (smooth)', note: 'Clean CAD finish', timeFactor: 1 },
	{ id: 'outer', label: 'Outer walls only', note: 'Tactile grip texture', timeFactor: 1.08 },
	{ id: 'all', label: 'All walls', note: 'Hides layer lines', timeFactor: 1.15 }
];

export const resinProfile: ResinProfile = {
	machineRate: 4.5,
	setupFee: 8,
	secondsPerLayer: 10,
	supportMlPerCm2: 0.3,
	overhangAngle: 50,
	hollowWall: 2
};

/** SLA layer heights; `note` is the tile's caption. */
export const resinQualities: QualityOption[] = [
	{ id: 'ultra', label: 'Ultra Detail', layerHeight: 0.025, note: 'Jewelry & Minis' },
	{ id: 'standard', label: 'Standard', layerHeight: 0.05, note: 'Recommended' },
	{ id: 'draft', label: 'Draft', layerHeight: 0.1, note: 'Fit Checks' }
];

export const shellStrategies: ShellStrategy[] = [
	{ id: 'hollow', label: 'Hollow', note: `${resinProfile.hollowWall.toFixed(1)} mm walls, drained`, hollow: true },
	{ id: 'solid', label: 'Solid', note: 'Max rigidity, more resin', hollow: false }
];

export const resinDefaults = {
	qualityId: 'standard',
	shellId: 'solid'
};

// ---------- CNC: machine constants (Makera Z1) ----------

export const machiningProfile: MachiningProfile = {
	stockMargin: 5,
	rotary: { diameter: 80, length: 150 },
	standardTool: 3.175,
	// Makera extended pack (52 pc).
	tools: [
		{ kind: 'flat', diameter: 3.175, reach: 12 },
		{ kind: 'flat', diameter: 2, reach: 8 },
		{ kind: 'flat', diameter: 1, reach: 3 },
		{ kind: 'long', diameter: 3.175, reach: 25 },
		{ kind: 'long', diameter: 3.175, reach: 42 },
		{ kind: 'v-bit', diameter: 0.1, label: '60°' },
		{ kind: 'v-bit', diameter: 0.2, label: '30°' },
		{ kind: 'v-bit', diameter: 0.3, label: '30°' },
		{ kind: 'ball', diameter: 3.175, reach: 10 },
		{ kind: 'ball', diameter: 2, reach: 6 },
		{ kind: 'ball', diameter: 1, reach: 3 },
		{ kind: 'single-flute', diameter: 3.175, reach: 22 },
		{ kind: 'single-flute', diameter: 2, reach: 12 },
		{ kind: 'single-flute', diameter: 1, reach: 4 },
		{ kind: 'drill', diameter: 1 },
		{ kind: 'drill', diameter: 2 },
		{ kind: 'drill', diameter: 2.5 },
		{ kind: 'drill', diameter: 3 },
		{ kind: 'corn', diameter: 0.8 },
		{ kind: 'corn', diameter: 1 },
		{ kind: 'corn', diameter: 2 },
		{ kind: 'corn', diameter: 3 },
		{ kind: 'thread-mill', diameter: 2.4, reach: 9, label: 'M3' },
		{ kind: 'thread-mill', diameter: 3.15, reach: 12, label: 'M4' },
		{ kind: 'thread-mill', diameter: 4, reach: 15, label: 'M5' },
		{ kind: 'chamfer', diameter: 3.175, label: '90°' }
	],
	hiddenMinArea: 2,
	hiddenMinShare: 0.0005
};

/** Cutters that can clear a pocket (plunge and cut sideways), with a known reach. */
export const pocketCutters = machiningProfile.tools
	.filter((t): t is CuttingTool & { reach: number } => ['flat', 'long', 'ball', 'single-flute'].includes(t.kind) && t.reach !== undefined)
	.map(({ diameter, reach }) => ({ diameter, reach }));

/** The smallest square-ended cutter: the tightest internal corner radius we can make. */
export const finestCornerTool = Math.min(
	...machiningProfile.tools.filter((t) => t.kind === 'flat' || t.kind === 'single-flute').map((t) => t.diameter)
);

export const machiningRates = {
	/** $ per spindle hour. */
	machineRate: 15
};

/** Stock groups in display order; only groups the store has stock for are shown. */
export const stockGroups: { id: StockGroup; label: string }[] = [
	{ id: 'metal', label: 'Metal' },
	{ id: 'plastic', label: 'Plastic' },
	{ id: 'composite', label: 'Composite' },
	{ id: 'wood', label: 'Wood' }
];

export const axisModes: AxisMode[] = [
	{
		id: 'three',
		label: '3-Axis',
		note: 'Top-down milling',
		firstSetupFee: 15,
		additionalSetupFee: 8,
		setupMinutes: 8,
		removalRate: { metal: 350, plastic: 1200, composite: 600, wood: 1800 },
		finishFeed: 1000,
		stepover: 0.5,
		floorStepover: 1.25,
		wallPassHeight: 12,
		finishOverhead: 1
	},
	{
		id: 'four',
		label: '4-Axis',
		note: 'Rotary, bar stock',
		firstSetupFee: 25,
		additionalSetupFee: 12,
		setupMinutes: 6,
		removalRate: { metal: 280, plastic: 1000, composite: 500, wood: 1500 },
		finishFeed: 800,
		stepover: 0.4,
		floorStepover: 1.25,
		wallPassHeight: 12,
		finishOverhead: 1.25
	}
];

export const machiningDefaults = {
	axes: 'three' as AxisMode['id']
};

/** Volume discounts as the store applies them at checkout ($ off each unit; doubled for CNC, see `tierScale`). */
export const priceTiers: PriceTier[] = [
	{ label: '1 unit', minQty: 1, amountOff: 0 },
	{ label: '2 – 5 units', minQty: 2, amountOff: 2 },
	{ label: '6 – 10 units', minQty: 6, amountOff: 3 },
	{ label: '11 – 50 units', minQty: 11, amountOff: 4 },
	{ label: '51+ units', minQty: 51, amountOff: 5 }
];

export const defaults = {
	processId: 'fdm',
	qualityId: 'standard',
	infill: 15,
	nozzle: 0.4,
	infillPattern: 'gyroid',
	wallLoops: 3,
	topShells: 5,
	bottomShells: 4,
	wallSequence: 'inner-outer',
	detectThinWalls: true,
	supportPlacement: 'everywhere',
	overhangAngle: 45,
	supportInterface: 'same',
	xyHoleCompensation: 0,
	xyContourCompensation: 0,
	ironing: false,
	fuzzySkin: 'none'
};

/**
 * What the configurator starts on, by store id (collection / product handle,
 * or stock id). Missing ones fall back to the first available.
 */
export const preferredDefaults = {
	categoryId: 'medium-duty-functional-use',
	materialId: '1g-petg-hf',
	resinId: 'standard-uv-resin',
	stockId: '6061-aluminum'
};

/** Store data the configurator needs, loaded from Shopify (see `$lib/server/catalog`). */
export type Catalog = {
	/** Filament collections, in store order. A filament can sit in several. */
	materialCategories: MaterialCategory[];
	resins: Resin[];
	stockMaterials: StockMaterial[];
	/** Groups that have stock, in display order. */
	stockGroups: { id: StockGroup; label: string }[];
	supportInterfaces: SupportInterface[];
	/** Starting selections, resolved against what the store has. */
	defaults: { categoryId: string; materialId: string; resinId: string; stockId: string };
	/** ms epoch when the data was read from Shopify. */
	fetchedAt: number;
};
