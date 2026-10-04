/**
 * Plain-language explanations behind the "?" next to each configurator
 * setting, for customers who don't know the jargon.
 */
export type SettingHelp = {
	title: string;
	/** Paragraphs. */
	body: string[];
	/** Optional rule of thumb, shown highlighted. */
	tip?: string;
};

export const settingHelp = {
	// ---------- FDM: material ----------
	fdmMaterial: {
		title: 'Material & Color',
		body: [
			'FDM printers melt a plastic filament and lay it down line by line. The filament you pick decides how strong, stiff, heat-resistant or flexible your part is, and what it looks like.',
			"The price per gram depends on the material and sometimes the color. Engineering filaments (carbon-fiber, nylon, polycarbonate) cost more but handle much more load and heat."
		],
		tip: 'Not sure? PLA is great for display pieces and prototypes; PETG is a tougher all-rounder for functional parts.'
	},
	materialCategory: {
		title: 'Material Category',
		body: [
			'Filaments are grouped by what they are good at: everyday and decorative prints, functional parts, heavy-duty and industrial use, special finishes, and high-performance engineering materials.',
			'Pick the group that matches how your part will be used, then choose a specific filament from it.'
		]
	},
	materialPolymer: {
		title: 'Material Polymer',
		body: [
			'The exact plastic your part is printed in. The line under the material name lists its strength (tensile, in MPa — higher is stronger), the temperature it starts to soften at, and its density. The datasheet link has the full specs.',
			'"Enclosed printer" materials such as ABS, ASA, nylon and polycarbonate warp in open air, so they are only offered on printers with a heated enclosure. Large-Scale FDM is open-frame, so it lists only materials that print without one.',
			'Each material is also approved for certain nozzle sizes only. If your current nozzle doesn’t suit the material you pick, it switches to the closest one that does.'
		]
	},
	color: {
		title: 'Variant / Color',
		body: [
			'The color of the filament. Each color is a separate spool, so stock and occasionally price differ between colors.',
			'Colors marked Backorder are not on hand; we order them from the manufacturer when you place your order, which can add a few days.'
		]
	},

	// ---------- FDM: layers & nozzle ----------
	layersNozzle: {
		title: 'Layers & Nozzle',
		body: [
			'A print is built from thin horizontal layers squeezed out of a nozzle. Together, the layer height and the nozzle size decide how smooth and detailed the part is, and how long it takes.'
		]
	},
	layerHeight: {
		title: 'Surface Quality (Layer Height)',
		body: [
			'How thick each layer is. Thinner layers make curved and sloped surfaces smoother and show fewer "stair steps", but the part needs more layers, so it takes longer and costs more.',
			"Flat vertical walls look about the same at any setting; it's tops of domes, slopes and fine text that benefit from thinner layers."
		],
		tip: 'Standard is right for most parts. Use Fine for visible curved surfaces, Draft for quick fit checks.'
	},
	nozzle: {
		title: 'Nozzle Size',
		body: [
			'The diameter of the hole the plastic comes out of. A smaller nozzle draws thinner lines, so it captures small text, sharp corners and thin features, but prints much more slowly.',
			'A larger nozzle lays down thick lines: faster and stronger walls, but it rounds off fine detail. Features thinner than the line width may be skipped — the model checks warn you about these.',
			"Not every filament works with every nozzle. Filled filaments (carbon or glass fiber, wood, marble, glitter) would clog a small nozzle, and some, like flexible TPU or light-weight foaming PLA, only print reliably at certain sizes. Sizes your material can't use are greyed out; switch materials to unlock them."
		],
		tip: '0.4 mm suits almost everything. Go smaller only for tiny detail, larger for big, chunky functional parts.'
	},

	// ---------- FDM: walls & shells ----------
	wallsShells: {
		title: 'Walls & Shells',
		body: [
			'Printed parts are not solid by default: they have a solid outer skin (walls on the sides, shells on top and bottom) around a lighter inside (infill).',
			'A thicker skin makes the part stronger and more watertight, and is the most effective way to add strength — usually more so than adding infill.'
		]
	},
	wallLoops: {
		title: 'Wall Loops',
		body: [
			'How many solid lines trace the outside of each layer. More loops make thicker side walls: stronger, stiffer, and better at holding screws and threaded inserts.',
			'Each extra loop adds material and time.'
		],
		tip: '2–3 loops for general parts; 4+ for parts that take screws or heavy load.'
	},
	topShells: {
		title: 'Top Shells',
		body: [
			'How many solid layers cap the top of the part. Too few and the top can sag between the infill lines ("pillowing") or show the pattern underneath.',
			'The number next to it is the resulting thickness at your layer height.'
		]
	},
	bottomShells: {
		title: 'Bottom Shells',
		body: ['How many solid layers form the floor of the part. More layers make a stiffer, more watertight base.']
	},
	wallOrder: {
		title: 'Wall Printing Order',
		body: [
			'Which wall line is printed first on each layer.',
			'Inner / Outer prints the hidden inner walls first, so the visible outer wall has something to lean on: overhangs come out cleaner.',
			'Outer / Inner prints the visible wall first against nothing, so it lands exactly where the model says: better dimensional accuracy for parts that must fit together.'
		]
	},
	detectThinWalls: {
		title: 'Detect Thin Walls',
		body: [
			'Some features are thinner than two printed lines, like thin fins, ribs or lettering. Normally the slicer may leave them out entirely.',
			'With this on, those features are printed as a single line instead. They come out a little weaker, but they are there.'
		],
		tip: 'Leave it on unless you know you need it off.'
	},

	// ---------- FDM: infill ----------
	infill: {
		title: 'Infill',
		body: [
			'The inside of the part is filled with a lightweight internal pattern instead of solid plastic. This saves material and time while keeping the part rigid.'
		]
	},
	infillDensity: {
		title: 'Infill Density',
		body: [
			'How much of the inside is filled, from hollow-ish to completely solid. Higher density makes the part heavier, stiffer and better at taking compression, but uses more material and takes longer.',
			'Strength grows much more slowly than cost: going from 30% to 100% roughly triples the material but adds far less strength than adding wall loops.'
		],
		tip: '15% for display pieces, 30% for functional parts, 60%+ for parts under real load.'
	},
	infillPattern: {
		title: 'Infill Pattern',
		body: [
			'The shape of the internal structure. Gyroid is equally strong in every direction and slightly flexible. Grid is fast and simple. Cubic handles crushing loads well. Triangles is very rigid in the flat plane.',
			'Lightning only builds enough inside to hold up the top surface. It is the fastest and cheapest, but adds no real strength, so use it only for decorative parts.'
		]
	},

	// ---------- FDM: supports ----------
	supports: {
		title: 'Supports',
		body: [
			'Each layer has to rest on the one below. Parts of the model that hang out over empty space (overhangs, bridges, the underside of arches) need temporary scaffolding underneath, which is snapped off after printing.',
			'Supports use extra material and can leave small marks where they touched the part.'
		]
	},
	supportPlacement: {
		title: 'Support Placement',
		body: [
			'Where supports are allowed. Everywhere supports every overhang, including ones that would rest on the part itself. Build Plate Only only builds supports that stand on the print bed, which keeps holes and internal cavities clean but leaves some overhangs unsupported.',
			'None prints without supports. Only choose it if the part is designed to print without them, or saggy overhangs may fail.'
		]
	},
	overhangAngle: {
		title: 'Overhang Threshold',
		body: [
			'How steep a surface can lean out before it gets a support, measured from vertical. Most filaments can print overhangs up to about 45° on their own.',
			'A higher threshold uses fewer supports (cheaper, fewer marks) but risks droopy undersides. The overhang view in the 3D preview shows which areas will be supported.'
		]
	},
	supportInterface: {
		title: 'Interface Material',
		body: [
			'The layer where the support touches your part. Same material is the standard: supports snap off and leave a slightly rough underside.',
			'Soluble PVA prints that contact layer in a material that dissolves in water, so supports come away completely and leave a clean surface. It costs more but is great for complex internal overhangs.'
		]
	},

	// ---------- FDM: accuracy & finish ----------
	dimensionalAccuracy: {
		title: 'Dimensional Accuracy',
		body: [
			'Melted plastic spreads slightly, so printed holes come out a little small and outer edges a little large. These offsets correct for that when parts must fit precisely, like press-fit bearings, screws or mating parts.',
			'Leave them at 0 unless you know your fit needs adjusting.'
		]
	},
	holeCompensation: {
		title: 'XY Hole Compensation',
		body: [
			'Grows (positive) or shrinks (negative) every hole in the part by this much. Use a small positive value, like +0.1 mm, if pins, bearings or bolts need to slide in without drilling out.'
		]
	},
	contourCompensation: {
		title: 'XY Contour Compensation',
		body: [
			'Moves the outside edges of the part in or out by this much. A small negative value makes a part slightly smaller so it slots into another part or a cut-out.'
		]
	},
	surfaceFinish: {
		title: 'Surface Finish',
		body: ['Optional extra passes that change how the outside of the part looks and feels.']
	},
	ironing: {
		title: 'Iron Top Surfaces',
		body: [
			'After printing each flat top surface, the hot nozzle passes over it again with very little plastic, melting the lines together into a smooth, almost glossy finish.',
			'It only affects flat, upward-facing surfaces and adds print time.'
		]
	},
	fuzzySkin: {
		title: 'Fuzzy Skin',
		body: [
			'Adds a fine random wobble to the outer walls, giving a matte, textured surface like a grip or sandblasted finish. It hides layer lines well.',
			'It slightly changes the outer dimensions, so avoid it on surfaces that must fit precisely.'
		]
	},

	// ---------- SLA ----------
	resin: {
		title: 'Photopolymer Resin',
		body: [
			'SLA (resin) printing builds the part from liquid resin that hardens under UV light, one very thin layer at a time. It produces much finer detail and smoother surfaces than FDM, which makes it ideal for miniatures, jewelry, small precise parts and smooth display pieces.',
			"The resin's properties under the name tell you how strong it is (tensile), how far it stretches before breaking (elongation) and the temperature it starts to soften at (heat deflection)."
		]
	},
	resinType: {
		title: 'Resin Type',
		body: [
			'The resin formulation. Different resins trade off detail, toughness, flexibility and heat resistance. Standard resin is crisp and detailed but more brittle than most plastics.'
		]
	},
	pigment: {
		title: 'Pigment',
		body: [
			'The color of the resin. Clear and translucent resins let light through; opaque ones show surface detail best.',
			'Pigments marked as Backorder are ordered from the manufacturer when you place your order.'
		]
	},
	resinLayer: {
		title: 'Layer Resolution (Z-Pitch)',
		body: [
			'How thick each cured layer is. Resin layers are already far thinner than FDM layers, so layer lines are nearly invisible at any setting.',
			'Thinner layers capture the finest detail but take longer, because every layer is cured separately regardless of the part size.'
		],
		tip: 'Standard suits nearly everything. Ultra Detail is for miniatures and jewelry; Draft for quick fit checks.'
	},
	resinShell: {
		title: 'Internal Shell',
		body: [
			'Solid prints the part completely full of resin: heaviest, stiffest, and most expensive.',
			'Hollow prints only a thick outer shell and drains the inside, using much less resin and making the part lighter. Small drain holes are added in a hidden spot so liquid resin can escape.'
		],
		tip: 'Hollow is a good saving on large display parts; keep small or load-bearing parts solid.'
	},
	resinPost: {
		title: 'Post-Wash & UV Cure',
		body: [
			'Fresh resin prints are sticky and not yet at full strength. Every part is washed in alcohol to remove leftover liquid resin, then cured under UV light and heat until it reaches its rated strength.',
			'Supports are removed and their contact points sanded smooth. This is always included.'
		]
	},

	// ---------- CNC ----------
	stockMaterial: {
		title: 'Stock Material',
		body: [
			'CNC machining starts with a solid piece of material (the stock) and cuts away everything that is not your part with a spinning cutter. The result is a strong, precise part in a real engineering material.',
			'The machine is programmed from your CAD file, so CNC needs a STEP (.step / .stp) file: export one from your CAD software. Mesh files (STL, OBJ, 3MF) can be previewed and estimated, but not ordered.',
			'The price shown is the cheapest standard stock size for this material. Your part uses the smallest standard piece it fits in, and that whole piece is charged; parts too big for any standard size get stock cut to order.'
		]
	},
	stockMaterialPick: {
		title: 'Material',
		body: [
			'Metals (aluminum, brass, copper) are strong and durable, for mechanical parts. Plastics (Delrin, acrylic, polycarbonate) are light, low-friction or clear. Composites (carbon fiber, FR-4 circuit board, phenolic) suit stiff plates, electronics and fixtures.',
			'Harder materials take longer to cut, so they cost more in machine time as well as material.'
		]
	},
	axes: {
		title: 'Machining Axes',
		body: [
			'3-Axis cuts straight down into the stock from above. To reach other sides, the part is flipped and re-clamped; each flip is another setup. The first setup carries the full setup fee (fixturing, zeroing, programming); each extra one costs less, since the job is already prepared. Features on angled faces may not be reachable at all.',
			'4-Axis holds a bar of stock on a rotating spindle, so the cutter can reach all the way around it in one setup. Better for round parts, side holes and wrap-around features.'
		],
		tip: 'Flat, plate-like parts suit 3-axis; round or many-sided parts suit 4-axis. The checks recommend one when it helps.'
	},
	orientation: {
		title: 'Orientation',
		body: [
			'How the part sits in the machine. On 3-axis the cutter comes straight down, so most features should face up. On 4-axis the part rotates around its long axis, which should run left to right.',
			'Use the rotate tool in the preview to turn the part; the checks and price update as you go.'
		]
	}
} satisfies Record<string, SettingHelp>;

export type HelpKey = keyof typeof settingHelp;
