/**
 * Materials Library: the shapes the /materials pages render, and the copy and
 * rules Forge owns itself. Everything else on those pages (materials, tiers,
 * ratings, colours, stock, technical data, photos) comes from Shopify; see
 * `$lib/server/library`.
 */

/** A Shopify CDN image, with widths Shopify resizes it to on request. */
export type LibraryImage = { src: string; srcset: string; alt: string; width?: number; height?: number };

/** 1–5 relative to the other filaments we stock (product `custom.rating_*` metafields). */
export type Ratings = { strength: number; heat: number; flexibility: number; finish: number };

export type LibraryColor = {
	/** Shopify variant id. */
	id: string;
	name: string;
	hex: string;
	/** $ per gram. */
	price: number;
	inStock: boolean;
	/** When an out-of-stock colour should be on the shelf (supplier ETA + a few days), ISO date. */
	arrives?: string;
	/** Nozzle sizes (mm) the colour is approved for; unset allows every size. */
	nozzles?: number[];
	image?: LibraryImage;
};

/** Colours of one value of the product's other option (e.g. Type: Basic / Translucent); `name` is null when there's none. */
export type LibraryColorGroup = { name: string | null; colors: LibraryColor[] };

export type Tag = { label: string; tone: 'neutral' | 'warn' | 'teal' };

/** What a filament card on the index shows. */
export type FilamentSummary = {
	handle: string;
	name: string;
	blurb: string;
	pricePerGram: number;
	/** Some colours cost more than `pricePerGram`. */
	priceVaries: boolean;
	ratings: Ratings | null;
	/** Molecule drawing key (product `custom.molecule`), e.g. "PETG". */
	molecule?: string;
	/** "PET · glycol-modified + carbon fibre" */
	polymer?: string;
	swatches: string[];
	colorCount: number;
	nozzles?: number[];
	tags: Tag[];
	uses: UseId[];
	/** Tier (collection) handles the filament sits in. */
	tiers: string[];
};

export type TechnicalData = {
	heatDeflection?: number;
	tensileStrength?: number;
	elongation?: number;
	bendingModulus?: number;
	density?: number;
	datasheets: string[];
};

/** Everything a filament's detail page shows. */
export type FilamentDetail = FilamentSummary & {
	descriptionHtml: string;
	/** The product's first photo (a fallback for colours without their own). */
	cover?: LibraryImage;
	/** Print examples: the product photos not attached to any colour variant. */
	examples: LibraryImage[];
	groups: LibraryColorGroup[];
	/** Name of the option the groups split by ("Type", "Finish", "Hardness"), if any. */
	groupOption: string | null;
	requiresEnclosure: boolean;
	greatFor: string[];
	avoidFor: string[];
	designTips: string[];
	tech: TechnicalData;
};

/** A filament tier: an FDM collection (`custom.process` = "FDM"). */
export type LibraryTier = { handle: string; name: string; blurb: string; materials: string[] };

/** A resin or CNC stock card. */
export type ProcessCard = {
	id: string;
	name: string;
	blurb: string;
	/** "$0.12 /ml", "from $8.40" */
	price?: string;
	/** "Sheets 3–20 mm · Round bars Ø10–50 mm" */
	stock?: string;
	swatches: string[];
	image?: LibraryImage;
	href: string;
};

export type Library = {
	tiers: LibraryTier[];
	filaments: FilamentSummary[];
	resins: ProcessCard[];
	cnc: ProcessCard[];
};

// ---------- Forge's own copy and rules ----------

export type UseId = 'display' | 'proto' | 'func' | 'outdoor' | 'heat' | 'flex' | 'eng';

export const uses: { id: UseId; label: string; hint: string }[] = [
	{ id: 'display', label: 'Looks great on a shelf', hint: 'PLA is the go-to here: Silk or Sparkle if you want it to stand out.' },
	{ id: 'proto', label: 'Quick prototype', hint: 'Start in PLA: cheapest per gram and fastest to print. Move to PETG once the design is locked.' },
	{ id: 'func', label: 'Functional part', hint: 'PETG is the sensible default. Step up to PC or PA6-GF when it has to carry load.' },
	{ id: 'outdoor', label: 'Lives outdoors', hint: 'PETG, ASA or PC hold up much better than PLA in sun and a hot car.' },
	{ id: 'heat', label: 'Gets hot', hint: 'ABS, ASA and PC for warm places; PPS-CF or PPA-CF when it gets seriously hot.' },
	{ id: 'flex', label: 'Needs to bend', hint: 'TPU is the only truly flexible option: phone cases, gaskets, feet.' },
	{ id: 'eng', label: 'Engineering / load-bearing', hint: 'Glass- and carbon-fibre materials need a hardened nozzle, which we have.' }
];

/** Polymer families that shrug off UV and weather. */
const weatherproof = new Set(['PETG', 'ASA', 'PC', 'PET', 'PA12', 'PPA', 'PPS']);

/**
 * Which use-case filters a filament shows under, from its ratings and
 * molecule. `cheapestOfFamily` marks the cheapest PLA and PETG (the
 * prototyping picks).
 */
export function usesFor(r: Ratings, molecule: string | undefined, cheapestOfFamily: boolean): UseId[] {
	const out: UseId[] = [];
	if (r.finish >= 4 || molecule === 'PLA') out.push('display');
	if (cheapestOfFamily && (molecule === 'PLA' || molecule === 'PETG')) out.push('proto');
	if (r.strength >= 3 && r.heat >= 2) out.push('func');
	if (r.heat >= 3 && molecule && weatherproof.has(molecule)) out.push('outdoor');
	if (r.heat >= 3 && molecule !== 'PETG') out.push('heat');
	if (r.flexibility >= 4) out.push('flex');
	if (r.strength >= 4 && r.heat >= 3) out.push('eng');
	return out;
}

/** Badges from the product title and molecule (there's no Shopify field for these yet). */
export function tagsFor(title: string, molecule: string | undefined, r: Ratings | null): Tag[] {
	const tags: Tag[] = [];
	if (/-(cf|gf)\b/i.test(title)) tags.push({ label: 'Hardened nozzle', tone: 'warn' });
	if (molecule === 'ASA') tags.push({ label: 'UV resistant', tone: 'teal' });
	if (r && r.flexibility >= 4) tags.push({ label: 'Flexible', tone: 'teal' });
	if (/aero/i.test(title)) tags.push({ label: 'Lightweight', tone: 'teal' });
	if (/\bfr\b/i.test(title)) tags.push({ label: 'Flame retardant', tone: 'neutral' });
	return tags;
}

/** Polymer names for the molecule drawings, and what a title says is mixed in. */
const polymerNames: Record<string, string> = {
	PLA: 'polylactic acid',
	PETG: 'PET · glycol-modified',
	PET: 'polyethylene terephthalate',
	ABS: 'acrylonitrile · butadiene · styrene',
	ASA: 'acrylonitrile · styrene · acrylate',
	TPU: 'thermoplastic polyurethane',
	PC: 'bisphenol-A polycarbonate',
	PA6: 'polyamide 6 (nylon)',
	PA12: 'polyamide 12 (nylon)',
	PPS: 'polyphenylene sulfide',
	PPA: 'polyphthalamide (PA6T)'
};

export function polymerLabel(title: string, molecule: string | undefined) {
	if (!molecule || !polymerNames[molecule]) return undefined;
	const fill = /-cf\b/i.test(title) ? ' + carbon fibre' : /-gf\b/i.test(title) ? ' + glass fibre' : /\bfr\b/i.test(title) ? ' + FR additive' : '';
	return polymerNames[molecule] + fill;
}

export const ratingRows: { key: keyof Ratings; label: string; short: string; words: string[] }[] = [
	{ key: 'strength', label: 'Strength', short: 'Strength', words: ['Low', 'Fair', 'Good', 'High', 'Top'] },
	{ key: 'heat', label: 'Heat resistance', short: 'Heat', words: ['Low', 'Fair', 'Good', 'High', 'Top'] },
	{ key: 'flexibility', label: 'Flexibility', short: 'Flex', words: ['Rigid', 'Some', 'Moderate', 'Bendy', 'Rubbery'] },
	{ key: 'finish', label: 'Surface finish', short: 'Finish', words: ['Rough', 'Plain', 'Good', 'Fine', 'Showpiece'] }
];

/** Days a backordered spool takes from the supplier's ETA to our shelf. */
export const shelfLagDays = 3;

/** "0.2–0.8 mm", "0.4 mm", "Any". */
export function nozzleRange(sizes: number[] | undefined) {
	if (!sizes?.length) return 'Any';
	const lo = Math.min(...sizes);
	const hi = Math.max(...sizes);
	return lo === hi ? `${lo} mm` : `${lo}–${hi} mm`;
}

/** "Sheets 3–20 mm · Round bars Ø10–50 mm · Blocks 35–50 mm" from each stock product's shape and sizes (mm). */
export function stockLabel(items: { shape: string; sizes: number[] }[]) {
	const shapes: [string, string, string][] = [
		['Sheet', 'Sheets', ''],
		['Round Bar', 'Round bars', 'Ø'],
		['Block', 'Blocks', '']
	];
	return shapes
		.map(([shape, label, prefix]) => {
			const sizes = items.filter((i) => i.shape === shape).flatMap((i) => i.sizes.filter(Number.isFinite));
			if (!sizes.length) return '';
			const lo = Math.min(...sizes), hi = Math.max(...sizes);
			return `${label} ${prefix}${lo === hi ? lo : `${lo}–${hi}`} mm`;
		})
		.filter(Boolean)
		.join(' · ');
}

export function money(n: number) {
	return `$${n.toFixed(2)}`;
}
