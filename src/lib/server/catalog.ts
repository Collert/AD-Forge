/**
 * The configurator's catalog, built from the Shopify store and cached in
 * memory: requests within `FRESH_MS` of the last fetch are served straight
 * from the cache; after that the cached copy is still served instantly while
 * a fresh one loads in the background (stale-while-revalidate). If Shopify is
 * unreachable the last good catalog keeps being served.
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
import { filamentTraits, hasStockTraits, resinTraits, stockMaterialTraits } from './material-traits';
import {
	CNC_STOCK_TYPE,
	PRINT_MATERIAL_TYPE,
	fetchStoreData,
	productFields,
	variantFields,
	type ShopifyCollection,
	type ShopifyProduct,
	type ShopifyVariant
} from './shopify';

/** How long a fetched catalog is served before it's refreshed in the background. */
const FRESH_MS = 5 * 60_000;

/** Preview colour for variants without a `custom.color` metafield. */
const FALLBACK_HEX = '#D9DDE1';

let cached: Catalog | null = null;
let pending: Promise<Catalog> | null = null;

export async function getCatalog(): Promise<Catalog> {
	if (cached && Date.now() - cached.fetchedAt < FRESH_MS) return cached;
	pending ??= buildCatalog()
		.then((catalog) => (cached = catalog))
		.finally(() => (pending = null));
	if (!cached) return pending;
	pending.catch((err) => console.error('Catalog refresh failed; serving the cached copy.', err));
	return cached;
}

async function buildCatalog(): Promise<Catalog> {
	const { products, collections } = await fetchStoreData();
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
		fetchedAt: Date.now()
	};
}

/** Resins are priced per millilitre; filaments per gram. */
function isResin(product: ShopifyProduct) {
	const uom = productFields(product).uom_abbreviation?.toLowerCase();
	return uom ? uom === 'ml' : product.tags.includes('Resin');
}

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
	const density = num(fields.density) ?? traits.density;
	const requiresEnclosure = fields.requires_enclosure === 'true';
	return {
		id: product.handle,
		label: product.title,
		name: product.title,
		density,
		pricePerGram: minPrice(colors)!,
		speedFactor: traits.speedFactor,
		specs: filamentSpecs(product.description, density, requiresEnclosure),
		inStock: colors.some((c) => c.inStock),
		requiresEnclosure,
		colors,
		datasheetUrl: fields.technical_datasheet,
		slicerPreset: fields.orca_filament?.trim() || undefined,
		nozzles: approvedNozzles(fields.approved_nozzles)
	};
}

/** `custom.approved_nozzles` (a JSON list like ["0.4","0.6"]) as sizes; undefined when unset or unreadable. */
function approvedNozzles(value: string | undefined): number[] | undefined {
	try {
		const sizes = (JSON.parse(value ?? '') as unknown[]).map(Number).filter((n) => Number.isFinite(n) && n > 0);
		return sizes.length ? sizes : undefined;
	} catch {
		return undefined;
	}
}

/** "Tensile: 39 MPa • Heat Deflect: 55°C • 1.24 g/cm³", from what the description states. */
function filamentSpecs(description: string, density: number, requiresEnclosure: boolean) {
	const tensile = description.match(/tensile[^.]{0,40}?(\d+(?:\.\d+)?)\s*(?:±\s*\d+(?:\.\d+)?\s*)?MPa/i)?.[1];
	const heat = description.match(/(?:heat[- ]deflection|HDT)[^.]{0,40}?(\d{2,3})\s*°\s*C/i)?.[1];
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
function swatches(product: ShopifyProduct): ColorOption[] {
	return product.variants.nodes
		.filter((v) => v.availableForSale)
		.map((v) => ({
			id: v.id,
			name: v.title === 'Default Title' ? 'Standard' : v.title,
			hex: variantFields(v).color ?? FALLBACK_HEX,
			price: Number(v.price.amount),
			inStock: isInStock(v)
		}));
}

/** On hand (untracked inventory counts as on hand); orderable variants without stock are backorders. */
function isInStock(variant: ShopifyVariant) {
	return variant.quantityAvailable === null || variant.quantityAvailable > 0;
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

function num(value: string | undefined) {
	const n = Number(value);
	return value && Number.isFinite(n) && n > 0 ? n : undefined;
}

function words(text: string) {
	return text.toLowerCase().match(/[a-z0-9-]+/g) ?? [];
}

function slug(text: string) {
	return words(text).join('-');
}
