/**
 * The Materials Library (/materials), built from the same cached Shopify data
 * as the configurator's catalog. What comes from where:
 *
 * - Process tabs: FDM tiers are collections whose `custom.process` is "FDM"
 *   (title + description); resins and CNC stock are their product types.
 * - Filament cards: title, lowest variant price, SEO description, the
 *   `custom.rating_*` and `custom.molecule` metafields, variant colours.
 * - Detail page: variant options (type × colour), stock and restock ETA
 *   (Spoolman, else Shopify), `custom.approved_nozzles` per variant, the great-for / avoid / tips
 *   lists, the `custom.technical_data` metaobject, and the product photos,
 *   served and resized by Shopify's CDN.
 */
import {
	polymerLabel,
	stockLabel,
	tagsFor,
	usesFor,
	type FilamentDetail,
	type FilamentSummary,
	type Library,
	type LibraryColor,
	type LibraryColorGroup,
	type LibraryImage,
	type LibraryTier,
	type ProcessCard,
	type Ratings
} from '$lib/catalog/library';
import { stockGroups } from '$lib/catalog/config';
import { FALLBACK_HEX, approvedNozzles, isInStock, isResin, jsonList, num, restockOf, technicalData } from './catalog';
import { stockMaterialTraits } from './material-traits';
import {
	CNC_STOCK_TYPE,
	PRINT_MATERIAL_TYPE,
	fromStoreData,
	productFields,
	variantFields,
	type ShopifyImage,
	type ShopifyProduct,
	type StoreData
} from './shopify';

type Built = Library & { details: Map<string, FilamentDetail> };

const getBuilt = fromStoreData(buildLibrary);

export async function getLibrary(): Promise<Library> {
	const { tiers, filaments, resins, cnc } = await getBuilt();
	return { tiers, filaments, resins, cnc };
}

/** A filament's detail page data, its tiers, and up to three similar filaments to compare with. */
export async function getFilament(handle: string) {
	const lib = await getBuilt();
	const detail = lib.details.get(handle);
	if (!detail) return null;
	const tiers = lib.tiers.filter((t) => detail.tiers.includes(t.handle));
	const compare = lib.filaments
		.filter((f) => f.handle !== handle && f.tiers.some((t) => detail.tiers.includes(t)))
		.sort((a, b) => distance(detail.ratings, a.ratings) - distance(detail.ratings, b.ratings))
		.slice(0, 3);
	return { material: detail, tiers, compare };
}

function distance(a: Ratings | null, b: Ratings | null) {
	if (!a || !b) return 99;
	return Math.abs(a.strength - b.strength) + Math.abs(a.heat - b.heat) + Math.abs(a.flexibility - b.flexibility) + Math.abs(a.finish - b.finish);
}

function buildLibrary({ products, collections }: StoreData): Built {
	const live = products.filter((p) => p.availableForSale);
	const printMaterials = live.filter((p) => p.productType === PRINT_MATERIAL_TYPE);
	const filamentProducts = new Map(printMaterials.filter((p) => !isResin(p)).map((p) => [p.handle, p]));

	const tierCollections = collections.filter((c) => c.process?.value.trim().toUpperCase() === 'FDM');
	const tiersOf = new Map<string, string[]>();
	for (const c of tierCollections) {
		for (const { handle } of c.products.nodes) {
			if (filamentProducts.has(handle)) tiersOf.set(handle, [...(tiersOf.get(handle) ?? []), c.handle]);
		}
	}

	const details = new Map<string, FilamentDetail>();
	for (const [handle, tiers] of tiersOf) {
		const detail = toDetail(filamentProducts.get(handle)!, tiers);
		if (detail) details.set(handle, detail);
	}

	// The cheapest of each polymer family is the prototyping pick.
	const cheapest = new Map<string, number>();
	for (const d of details.values()) {
		if (d.molecule) cheapest.set(d.molecule, Math.min(cheapest.get(d.molecule) ?? Infinity, d.pricePerGram));
	}
	for (const d of details.values()) {
		if (d.ratings) d.uses = usesFor(d.ratings, d.molecule, !!d.molecule && cheapest.get(d.molecule) === d.pricePerGram);
	}

	const tiers: LibraryTier[] = tierCollections
		.map((c) => ({
			handle: c.handle,
			name: c.title,
			blurb: tierBlurb(c.description),
			materials: c.products.nodes.map((p) => p.handle).filter((h) => details.has(h))
		}))
		.filter((t) => t.materials.length > 0)
		// Collections have no store order of their own: lightest duty first, the broader of two similar tiers first.
		.sort((a, b) => meanStrength(a, details) - meanStrength(b, details) || b.materials.length - a.materials.length);

	const order = tiers.flatMap((t) => t.materials).filter((h, i, all) => all.indexOf(h) === i);
	const filaments = order.map((h) => summary(details.get(h)!));

	return {
		tiers,
		filaments,
		resins: printMaterials.filter(isResin).map(toResinCard),
		cnc: toCncCards(live.filter((p) => p.productType === CNC_STOCK_TYPE)),
		details
	};
}

function meanStrength(tier: LibraryTier, details: Map<string, FilamentDetail>) {
	const r = tier.materials.map((h) => details.get(h)!.ratings?.strength ?? 3);
	return Math.round((r.reduce((a, b) => a + b, 0) / r.length) * 10) / 10;
}

/** The collection description's opening sentence, minus a "Great for:" lead-in. */
function tierBlurb(description: string) {
	const first = description.trim().match(/^.+?[.!?](?=\s|$)/)?.[0] ?? description.trim();
	const text = first.replace(/^great for:\s*/i, '');
	return text.charAt(0).toUpperCase() + text.slice(1);
}

function summary(d: FilamentDetail): FilamentSummary {
	const { handle, name, blurb, pricePerGram, priceVaries, ratings, molecule, polymer, swatches, colorCount, nozzles, tags, uses, tiers } = d;
	return { handle, name, blurb, pricePerGram, priceVaries, ratings, molecule, polymer, swatches, colorCount, nozzles, tags, uses, tiers };
}

// ---------- Filaments ----------

function toDetail(product: ShopifyProduct, tiers: string[]): FilamentDetail | null {
	const fields = productFields(product);
	const { groups, groupOption } = colorGroups(product);
	const colors = groups.flatMap((g) => g.colors);
	if (!colors.length) return null;

	const ratings = readRatings(fields);
	const molecule = fields.molecule?.trim() || undefined;
	const prices = colors.map((c) => c.price);
	const nozzles = [...new Set(colors.flatMap((c) => c.nozzles ?? []))].sort((a, b) => a - b);
	return {
		handle: product.handle,
		name: product.title,
		blurb: product.seo.description?.trim() || firstSentence(product.description),
		descriptionHtml: product.descriptionHtml,
		pricePerGram: Math.min(...prices),
		priceVaries: Math.max(...prices) > Math.min(...prices),
		ratings,
		molecule,
		polymer: polymerLabel(product.title, molecule),
		swatches: spread(colors).map((c) => c.hex),
		colorCount: colors.length,
		nozzles: nozzles.length ? nozzles : undefined,
		tags: tagsFor(product.title, molecule, ratings),
		uses: [],
		tiers,
		cover: product.images.nodes[0] && image(product.images.nodes[0], product.title),
		examples: printExamples(product),
		groups,
		groupOption,
		requiresEnclosure: fields.requires_enclosure === 'true',
		greatFor: jsonList(fields.great_for),
		avoidFor: jsonList(fields.pick_something_else_for),
		designTips: jsonList(fields.design_tips),
		tech: technicalData(product)
	};
}

function readRatings(fields: Record<string, string | undefined>): Ratings | null {
	const r = [fields.rating_strength, fields.rating_heat, fields.rating_flexibility, fields.rating_finish].map((v) => {
		const n = Math.round(Number(v));
		return v && n >= 1 && n <= 5 ? n : null;
	});
	if (r.some((v) => v === null)) return null;
	const [strength, heat, flexibility, finish] = r as number[];
	return { strength, heat, flexibility, finish };
}

/**
 * Orderable variants as colour swatches, grouped by the product's other
 * option when it has one (PETG: Type → Basic / Translucent).
 */
function colorGroups(product: ShopifyProduct): { groups: LibraryColorGroup[]; groupOption: string | null } {
	const variants = product.variants.nodes.filter((v) => v.availableForSale);
	const optionNames = [...new Set(variants.flatMap((v) => v.selectedOptions.map((o) => o.name)))];
	const colorOption = optionNames.find((n) => /colou?r/i.test(n));
	const groupOption = optionNames.find((n) => n !== colorOption && n !== 'Title') ?? null;

	const groups = new Map<string | null, LibraryColor[]>();
	for (const v of variants) {
		const f = variantFields(v);
		const option = (name: string | null | undefined) => (name ? v.selectedOptions.find((o) => o.name === name)?.value : undefined);
		const color: LibraryColor = {
			id: v.id,
			name: option(colorOption) ?? (v.title === 'Default Title' ? 'Standard' : v.title),
			hex: f.color ?? FALLBACK_HEX,
			price: Number(v.price.amount),
			inStock: isInStock(v),
			restock: restockOf(v),
			discontinued: v.stock?.discontinued || undefined,
			nozzles: approvedNozzles(f.approved_nozzles),
			image: v.image ? image(v.image, `${product.title} ${v.title}`) : undefined
		};
		const key = option(groupOption) ?? null;
		groups.set(key, [...(groups.get(key) ?? []), color]);
	}
	return { groups: [...groups].map(([name, colors]) => ({ name, colors })), groupOption };
}

/**
 * Product photos that aren't any variant's image. Variant images are the
 * per-colour spool and swatch shots; the rest are the printed parts and
 * showcase photos the store's product page shows alongside them.
 */
function printExamples(product: ShopifyProduct): LibraryImage[] {
	const key = (url: string) => url.split('?')[0];
	const colourShots = new Set(product.variants.nodes.flatMap((v) => (v.image ? [key(v.image.url)] : [])));
	return product.images.nodes.filter((img) => !colourShots.has(key(img.url))).map((img) => image(img, `${product.title} print example`));
}

/** Up to five swatches for a card, in stock first, spread across the range. */
function spread(colors: LibraryColor[], n = 5) {
	const sorted = [...colors].sort((a, b) => Number(b.inStock) - Number(a.inStock));
	if (sorted.length <= n) return sorted;
	const unique = sorted.filter((c, i) => sorted.findIndex((d) => d.hex === c.hex) === i);
	return unique.slice(0, n);
}

// ---------- Resins and CNC stock ----------

function toResinCard(product: ShopifyProduct): ProcessCard {
	const variants = product.variants.nodes.filter((v) => v.availableForSale);
	const price = Math.min(...variants.map((v) => Number(v.price.amount)));
	return {
		id: product.handle,
		name: product.title,
		blurb: product.seo.description?.trim() || firstSentence(product.description),
		price: Number.isFinite(price) ? `$${price.toFixed(2)} /ml` : undefined,
		swatches: unique(variants.map((v) => variantFields(v).color ?? FALLBACK_HEX)).slice(0, 6),
		image: product.images.nodes[0] && image(product.images.nodes[0], product.title),
		href: '/make/sla'
	};
}

/** One card per raw material (`custom.stock_material`), summing up every product cut from it. */
function toCncCards(products: ShopifyProduct[]): ProcessCard[] {
	const byMaterial = new Map<string, ShopifyProduct[]>();
	for (const p of products) {
		const material = productFields(p).stock_material?.trim();
		if (material) byMaterial.set(material, [...(byMaterial.get(material) ?? []), p]);
	}
	const groupOrder = stockGroups.map((g) => g.id);
	return [...byMaterial]
		.map(([material, items]) => {
			const variants = items.flatMap((p) => p.variants.nodes.filter((v) => v.availableForSale));
			const price = Math.min(...variants.map((v) => Number(v.price.amount)));
			const traits = stockMaterialTraits(material);
			const pictured = items.find((p) => p.images.nodes.length);
			return {
				card: {
					id: material.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
					name: material,
					blurb: traits.specs.replaceAll(' • ', ' · '),
					price: Number.isFinite(price) ? `from $${price.toFixed(2)}` : undefined,
					stock: stockLabel(
						items.map((p) => ({
							shape: productFields(p).stock_shape ?? '',
							sizes: p.variants.nodes.map((v) => {
								const f = variantFields(v);
								return num(f.diameter_mm) ?? num(f.thickness_mm) ?? Math.min(num(f.width_mm) ?? Infinity, num(f.length_mm) ?? Infinity);
							})
						}))
					),
					swatches: unique(variants.map((v) => variantFields(v).color).filter((c): c is string => !!c)).slice(0, 6),
					image: pictured && image(pictured.images.nodes[0], material),
					href: '/make/cnc'
				} satisfies ProcessCard,
				group: groupOrder.indexOf(traits.group)
			};
		})
		.sort((a, b) => a.group - b.group || a.card.name.localeCompare(b.card.name))
		.map((e) => e.card);
}

// ---------- Shared ----------

const IMAGE_WIDTHS = [320, 480, 640, 960, 1280, 1600];

/**
 * A product image, resized by Shopify's CDN: `?width=` returns a scaled copy
 * (in WebP/AVIF to browsers that accept them), so the page lists a few widths
 * and lets the browser pick.
 */
function image(img: ShopifyImage, fallbackAlt: string): LibraryImage {
	const sized = (w: number) => {
		const u = new URL(img.url);
		u.searchParams.set('width', String(w));
		return u.toString();
	};
	const widths = IMAGE_WIDTHS.filter((w) => !img.width || w <= img.width);
	if (!widths.length) widths.push(img.width ?? IMAGE_WIDTHS[0]);
	return {
		src: sized(widths[Math.min(2, widths.length - 1)]),
		srcset: widths.map((w) => `${sized(w)} ${w}w`).join(', '),
		alt: img.altText?.trim() || fallbackAlt,
		width: img.width ?? undefined,
		height: img.height ?? undefined
	};
}

function firstSentence(text: string) {
	const clean = text.replace(/\s+/g, ' ').trim();
	return clean.match(/^.{20,200}?[.!?](?=\s|$)/)?.[0] ?? clean.slice(0, 160);
}

function unique<T>(list: T[]) {
	return [...new Set(list)];
}
