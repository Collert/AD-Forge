/**
 * The configurator's catalog, built from the Shopify store data (cached and
 * refreshed in the background by `getStoreData`).
 */
import {
	preferredDefaults,
	solubleSupportHandle,
	stockGroups,
	supportInterfaceOptions,
	type Catalog,
	type ColorOption,
	type Material,
	type MaterialCategory,
	type Resin,
	type StockBar,
	type StockMaterial,
	type StockPiece,
	type SupportInterface
} from '$lib/catalog/config';
import type { TechnicalData } from '$lib/catalog/library';
import { filamentTraits, hasStockTraits, resinTraits, stockMaterialTraits } from './material-traits';
import {
	CNC_STOCK_TYPE,
	PRINT_MATERIAL_TYPE,
	fromStoreData,
	isResin,
	productFields,
	variantFields,
	type ShopifyCollection,
	type ShopifyProduct,
	type ShopifyVariant,
	type StoreData
} from './shopify';

/** Preview colour for variants without a `custom.color` metafield. */
export const FALLBACK_HEX = '#D9DDE1';

export const getCatalog = fromStoreData(buildCatalog);

function buildCatalog({ products, collections, fetchedAt }: StoreData): Catalog {
	const printMaterials = products.filter((p) => p.productType === PRINT_MATERIAL_TYPE && p.availableForSale);
	const resinProducts = printMaterials.filter(isResin);
	const filaments = printMaterials.filter((p) => !isResin(p));

	const materialCategories = filamentCategories(filaments, collections);
	const resins = resinProducts.map(toResin).filter((r) => r !== null);
	const stockMaterials = toStockMaterials(products.filter((p) => p.productType === CNC_STOCK_TYPE && p.availableForSale));

	const pva = filaments.find((p) => p.handle === solubleSupportHandle);
	const pvaMaterial = pva && toMaterial(pva);
	const supportInterfaces: SupportInterface[] = [supportInterfaceOptions.same];
	if (pvaMaterial) {
		const { name, density, slicerPreset, pricePerGram, colors } = pvaMaterial;
		supportInterfaces.push({ ...supportInterfaceOptions.soluble, pricePerGram, material: { name, density, slicerPreset, hex: colors[0].hex } });
	}

	return {
		materialCategories,
		resins,
		stockMaterials,
		stockGroups: stockGroups.filter((g) => stockMaterials.some((m) => m.group === g.id)),
		supportInterfaces,
		defaults: resolveDefaults(materialCategories, resins, stockMaterials),
		fetchedAt
	};
}

export { isResin } from './shopify';

// ---------- Filaments ----------

/** Store collections made up only of filaments, in store order; each is a picker category. */
function filamentCategories(filaments: ShopifyProduct[], collections: ShopifyCollection[]): MaterialCategory[] {
	const byHandle = new Map<string, Material>();
	for (const product of filaments) {
		const material = toMaterial(product);
		if (material) byHandle.set(product.handle, material);
	}
	const isFilament = new Set(filaments.map((p) => p.handle));

	return collections
		.filter((c) => c.products.nodes.length > 0 && c.products.nodes.every((p) => isFilament.has(p.handle)))
		.map((c) => ({
			id: c.handle,
			label: c.title,
			materials: c.products.nodes.map((p) => byHandle.get(p.handle)).filter((m) => m !== undefined)
		}))
		.filter((c) => c.materials.length > 0);
}

function toMaterial(product: ShopifyProduct): Material | null {
	const colors = swatches(product);
	if (!colors.length) return null;
	const fields = productFields(product);
	const traits = filamentTraits(product.title);
	const tech = technicalData(product);
	const density = num(fields.density) ?? tech.density ?? traits.density;
	const requiresEnclosure = fields.requires_enclosure === 'true';
	return {
		id: product.handle,
		label: product.title,
		name: product.title,
		density,
		pricePerGram: minPrice(colors)!,
		speedFactor: traits.speedFactor,
		specs: filamentSpecs(product.description, tech, density, requiresEnclosure),
		inStock: colors.some((c) => c.inStock),
		requiresEnclosure,
		colors,
		datasheetUrl: fields.technical_datasheet ?? tech.datasheets[0],
		slicerPreset: fields.orca_filament?.trim() || undefined,
		nozzles: productNozzles(product)
	};
}

/** Nozzle sizes (mm) any orderable colour is approved for; undefined when none says, so every size is allowed. */
function productNozzles(product: ShopifyProduct): number[] | undefined {
	const sizes = new Set<number>();
	for (const v of product.variants.nodes) {
		if (v.availableForSale) approvedNozzles(variantFields(v).approved_nozzles)?.forEach((n) => sizes.add(n));
	}
	if (!sizes.size) approvedNozzles(productFields(product).approved_nozzles)?.forEach((n) => sizes.add(n));
	return sizes.size ? [...sizes].sort((a, b) => a - b) : undefined;
}

/** `custom.approved_nozzles` (a JSON list like ["0.4","0.6"]) as sizes; undefined when unset or unreadable. */
export function approvedNozzles(value: string | undefined): number[] | undefined {
	try {
		const sizes = (JSON.parse(value ?? '') as unknown[]).map(Number).filter((n) => Number.isFinite(n) && n > 0);
		return sizes.length ? sizes : undefined;
	} catch {
		return undefined;
	}
}

/** The product's `custom.technical_data` metaobject, plus any `custom.technical_datasheets` links. */
export function technicalData(product: ShopifyProduct): TechnicalData {
	const f = Object.fromEntries((product.technicalData?.reference?.fields ?? []).map((x) => [x.key, x.value ?? undefined]));
	const sheets = [...jsonList(f.datasheets), ...jsonList(productFields(product).technical_datasheets)];
	return {
		heatDeflection: num(f.heat_deflection_temp_c),
		tensileStrength: num(f.tensile_strength_mpa),
		elongation: num(f.elongation_at_break_pct),
		bendingModulus: num(f.bending_modulus_mpa),
		density: num(f.density_g_cm3),
		datasheets: [...new Set(sheets)]
	};
}

/** A JSON list metafield (`list.*`) as strings; empty when unset or unreadable. */
export function jsonList(value: string | undefined): string[] {
	try {
		const list = JSON.parse(value ?? '[]') as unknown;
		return Array.isArray(list) ? list.map(String).filter((s) => s.trim()) : [];
	} catch {
		return [];
	}
}

/** "Tensile: 39 MPa • Heat Deflect: 55°C • 1.24 g/cm³", from the technical data, else what the description states. */
function filamentSpecs(description: string, tech: TechnicalData, density: number, requiresEnclosure: boolean) {
	const tensile = tech.tensileStrength ?? description.match(/tensile[^.]{0,40}?(\d+(?:\.\d+)?)\s*(?:±\s*\d+(?:\.\d+)?\s*)?MPa/i)?.[1];
	const heat = tech.heatDeflection ?? description.match(/(?:heat[- ]deflection|HDT)[^.]{0,40}?(\d{2,3})\s*°\s*C/i)?.[1];
	return [
		tensile && `Tensile: ${tensile} MPa`,
		heat && `Heat Deflect: ${heat}°C`,
		`${density} g/cm³`,
		requiresEnclosure && 'Enclosed printer'
	]
		.filter(Boolean)
		.join(' • ');
}

// ---------- Resins ----------

function toResin(product: ShopifyProduct): Resin | null {
	const pigments = swatches(product);
	if (!pigments.length) return null;
	const fields = productFields(product);
	const traits = resinTraits(product.title);
	return {
		id: product.handle,
		label: product.title,
		name: product.title,
		density: num(fields.density) ?? traits.density,
		pricePerMl: minPrice(pigments)!,
		exposureFactor: traits.exposureFactor,
		tensile: traits.tensile,
		elongation: traits.elongation,
		heatDeflect: traits.heatDeflect,
		pigments,
		inStock: pigments.some((p) => p.inStock)
	};
}

// ---------- CNC stock ----------

/**
 * One stock material per raw material and colour, gathering the pre-cut
 * pieces (3-axis: sheets, blocks) and bars (4-axis: round bars, and blocks as
 * square bars) of every product cut from it.
 */
function toStockMaterials(products: ShopifyProduct[]): StockMaterial[] {
	type Entry = { material: string; hex: string; colorName: string; pieces: StockPiece[]; bars: StockBar[]; inStock: boolean };
	const entries = new Map<string, Entry>();

	for (const product of products) {
		const fields = productFields(product);
		const material = fields.stock_material;
		if (!material) continue;
		if (!hasStockTraits(material)) console.warn(`CNC stock material "${material}" has no traits; treating it as plastic.`);
		const three = fields.cnc_3_axis_compatible === 'true';
		const four = fields.cnc_4_axis_compatible === 'true';

		for (const variant of product.variants.nodes) {
			if (!variant.availableForSale) continue;
			const v = variantFields(variant);
			const hex = v.color ?? FALLBACK_HEX;
			const key = [material, hex, v.secondary_color ?? ''].join('|').toLowerCase();
			let entry = entries.get(key);
			if (!entry) {
				entry = { material, hex, colorName: stockColorName(product, variant, material), pieces: [], bars: [], inStock: false };
				entries.set(key, entry);
			}

			const price = Number(variant.price.amount);
			const [t, w, l, d] = [v.thickness_mm, v.width_mm, v.length_mm, v.diameter_mm].map(num);
			if (three && t && w && l) entry.pieces.push({ x: l, y: w, z: t, price, variantId: variant.id });
			if (four && d && l) entry.bars.push({ shape: 'round', size: d, length: l, price, variantId: variant.id });
			else if (four && t && w && l) entry.bars.push({ shape: 'square', size: Math.min(t, w), length: l, price, variantId: variant.id });
			entry.inStock ||= isInStock(variant);
		}
	}

	const colorsOf = new Map<string, number>();
	for (const e of entries.values()) colorsOf.set(e.material, (colorsOf.get(e.material) ?? 0) + 1);

	const ids = new Set<string>();
	const groupOrder = stockGroups.map((g) => g.id);
	return [...entries.values()]
		.filter((e) => e.pieces.length || e.bars.length)
		.map((e): StockMaterial => {
			const traits = stockMaterialTraits(e.material);
			const showColor = (colorsOf.get(e.material) ?? 0) > 1 && e.colorName;
			let id = slug(showColor ? `${e.material} ${e.colorName}` : e.material);
			while (ids.has(id)) id += '-x';
			ids.add(id);
			return {
				id,
				label: showColor ? `${e.material} — ${e.colorName}` : e.material,
				name: e.material.replace(/\s*\(.*?\)/, ''),
				group: traits.group,
				density: traits.density,
				pieces: e.pieces,
				bars: e.bars,
				pricePerCm3: medianPricePerCm3(e.pieces, e.bars),
				color: e.hex,
				specs: traits.specs,
				inStock: e.inStock
			};
		})
		.sort((a, b) => groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group) || a.label.localeCompare(b.label));
}

/** "Black on White" from a colour option, else the title minus shape and material words ("White Delrin Sheet Plate" → "White"). */
function stockColorName(product: ShopifyProduct, variant: ShopifyVariant, material: string) {
	const option = variant.selectedOptions.find((o) => /colou?r/i.test(o.name));
	if (option) return option.value;
	const skip = new Set([...words(material), 'sheet', 'plate', 'round', 'bar', 'block', 'board', 'stock']);
	return product.title
		.split(/\s+/)
		.filter((w) => !skip.has(w.toLowerCase().replace(/[^a-z0-9-]/g, '')))
		.join(' ');
}

/** Typical $/cm³ across the standard sizes, for stock cut to order. */
function medianPricePerCm3(pieces: StockPiece[], bars: StockBar[]) {
	const rates = [
		...pieces.map((p) => p.price / ((p.x * p.y * p.z) / 1000)),
		...bars.map((b) => b.price / (((b.shape === 'round' ? Math.PI * (b.size / 2) ** 2 : b.size ** 2) * b.length) / 1000))
	].sort((a, b) => a - b);
	const mid = rates.length >> 1;
	return rates.length % 2 ? rates[mid] : (rates[mid - 1] + rates[mid]) / 2;
}

// ---------- Shared ----------

/** Orderable colour variants of a product. */
export function swatches(product: ShopifyProduct): ColorOption[] {
	return product.variants.nodes
		.filter((v) => v.availableForSale)
		.map((v) => ({
			id: v.id,
			name: v.title === 'Default Title' ? 'Standard' : v.title,
			hex: variantFields(v).color ?? FALLBACK_HEX,
			price: Number(v.price.amount),
			inStock: isInStock(v),
			restock: restockOf(v),
			discontinued: v.stock?.discontinued || undefined
		}));
}

/**
 * On hand: Spoolman's stock when the variant is tracked there, else Shopify's
 * (untracked inventory counts as on hand). Orderable variants without stock
 * are ordered in when an order is placed.
 */
export function isInStock(variant: ShopifyVariant) {
	if (variant.stock) return variant.stock.inStock;
	return variant.quantityAvailable === null || variant.quantityAvailable > 0;
}

/**
 * For a variant that isn't on hand, the manufacturer's restock ETA (ISO date)
 * when they're out too: Spoolman's `next_restock_date`, else the variant's
 * `custom.supplier_eta`. Undefined when the manufacturer has it.
 */
export function restockOf(variant: ShopifyVariant): string | undefined {
	if (isInStock(variant)) return undefined;
	if (variant.stock) return variant.stock.restock;
	const eta = Date.parse(variantFields(variant).supplier_eta ?? '');
	return Number.isFinite(eta) ? new Date(eta).toISOString().slice(0, 10) : undefined;
}

function minPrice(options: ColorOption[]) {
	return options.length ? Math.min(...options.map((o) => o.price)) : undefined;
}

function resolveDefaults(categories: MaterialCategory[], resins: Resin[], stock: StockMaterial[]): Catalog['defaults'] {
	const pref = preferredDefaults;
	const category = categories.find((c) => c.id === pref.categoryId) ?? categories[0];
	const material = category?.materials.find((m) => m.id === pref.materialId) ?? category?.materials[0];
	return {
		categoryId: category?.id ?? '',
		materialId: material?.id ?? '',
		resinId: (resins.find((r) => r.id === pref.resinId) ?? resins[0])?.id ?? '',
		stockId: (stock.find((s) => s.id === pref.stockId) ?? stock[0])?.id ?? ''
	};
}

export function num(value: string | undefined) {
	const n = Number(value);
	return value && Number.isFinite(n) && n > 0 ? n : undefined;
}

function words(text: string) {
	return text.toLowerCase().match(/[a-z0-9-]+/g) ?? [];
}

function slug(text: string) {
	return words(text).join('-');
}
