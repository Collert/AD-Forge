/**
 * Material properties the store doesn't carry: estimator tuning (print speed,
 * exposure) and fallbacks for metafields a product hasn't filled in yet.
 * Shopify data always wins where it exists.
 */
import type { StockGroup } from '$lib/catalog/config';

/** Filament families, matched in order against the product title. */
const filamentFamilies: { match: RegExp; density: number; speedFactor: number }[] = [
	{ match: /85a/i, density: 1.2, speedFactor: 0.4 },
	{ match: /tpu/i, density: 1.21, speedFactor: 0.5 },
	{ match: /aero/i, density: 0.8, speedFactor: 0.6 },
	{ match: /pa6|paht|ppa|pps|nylon/i, density: 1.22, speedFactor: 0.7 },
	{ match: /\bpc\b/i, density: 1.2, speedFactor: 0.75 },
	{ match: /-(cf|gf)\b/i, density: 1.22, speedFactor: 0.85 },
	{ match: /petg/i, density: 1.27, speedFactor: 0.9 },
	{ match: /abs|asa/i, density: 1.06, speedFactor: 0.9 },
	{ match: /silk/i, density: 1.24, speedFactor: 0.85 },
	{ match: /pva/i, density: 1.23, speedFactor: 0.6 }
];
const plaFamily = { density: 1.24, speedFactor: 1 };

export function filamentTraits(title: string) {
	return filamentFamilies.find((f) => f.match.test(title)) ?? plaFamily;
}

type ResinTraits = { density: number; exposureFactor: number; tensile: string; elongation: string; heatDeflect: string };

/** Resin families, matched in order against the product title. */
const resinFamilies: (ResinTraits & { match: RegExp })[] = [
	{ match: /tough|abs-like/i, density: 1.15, exposureFactor: 1.15, tensile: '52 MPa', elongation: '18%', heatDeflect: '68 °C' },
	{ match: /flex|tpu-like|elastic/i, density: 1.1, exposureFactor: 1.4, tensile: '8 MPa', elongation: '120%', heatDeflect: '—' },
	{ match: /high[- ]temp/i, density: 1.2, exposureFactor: 1.6, tensile: '58 MPa', elongation: '2%', heatDeflect: '230 °C' },
	{ match: /castable|wax/i, density: 1.08, exposureFactor: 1.3, tensile: '12 MPa', elongation: '10%', heatDeflect: '—' }
];
const standardResin: ResinTraits = { density: 1.12, exposureFactor: 1, tensile: '45 MPa', elongation: '8%', heatDeflect: '52 °C' };

export function resinTraits(title: string): ResinTraits {
	return resinFamilies.find((f) => f.match.test(title)) ?? standardResin;
}

type StockTraits = { group: StockGroup; density: number; specs: string };

/** CNC stock by its `custom.stock_material` metafield (lower case). */
const stockTraits: Record<string, StockTraits> = {
	'6061 aluminum': { group: 'metal', density: 2.7, specs: 'Tensile: 310 MPa • Anodizable • Corrosion resistant' },
	'7075 aluminum': { group: 'metal', density: 2.81, specs: 'Tensile: 570 MPa • Aerospace grade • High fatigue strength' },
	brass: { group: 'metal', density: 8.5, specs: 'Free-machining • Low friction • Polishes to a gold finish' },
	copper: { group: 'metal', density: 8.96, specs: 'Top electrical & thermal conductivity • Soft, gummy cut' },
	'delrin (pom)': { group: 'plastic', density: 1.41, specs: 'Low friction • Dimensionally stable • Gears & bushings' },
	'acrylic (pmma)': { group: 'plastic', density: 1.19, specs: 'Optically clear • Rigid • Flame-polishable edges' },
	polycarbonate: { group: 'plastic', density: 1.2, specs: 'Clear • Near-unbreakable • Heat resistant to ~130 °C' },
	'epoxy tooling board': { group: 'plastic', density: 0.7, specs: 'Dimensionally stable • Fine surface finish • Molds & fixtures' },
	'bicolor engraving laminate': { group: 'plastic', density: 1.1, specs: 'Engrave through the cap layer to reveal the core colour' },
	'fr-4 copper-clad pcb': { group: 'composite', density: 1.85, specs: 'Copper-clad FR-4 • Isolation milling & drilling' },
	'carbon fiber': { group: 'composite', density: 1.55, specs: 'Stiff & light • Abrasive: diamond-coated tooling' },
	'synthetic stone': { group: 'composite', density: 1.9, specs: 'Glass-fibre composite • Heat resistant • Fixtures & pallets' },
	'bakelite (phenolic)': { group: 'composite', density: 1.3, specs: 'Electrically insulating • Heat resistant • Jigs & fixtures' }
};

export function stockMaterialTraits(material: string): StockTraits {
	return stockTraits[material.toLowerCase()] ?? { group: 'plastic', density: 1.2, specs: '' };
}

export function hasStockTraits(material: string) {
	return material.toLowerCase() in stockTraits;
}
