/**
 * Matches Spoolman filaments to the store's filament variants and records
 * each variant's stock on it (`variant.stock`). A variant matches:
 *
 * 1. The filaments whose `shopify_variant_id` extra field is its Shopify id.
 * 2. Otherwise, by name, one filament without that field: every word of the
 *    filament's material is in the product or variant title, every word of
 *    the variant's colour (minus a bracketed description) is in the
 *    filament's material and name, and of those it shares the most words
 *    with the titles (an equal colour hex breaks a tie; a tie left after that
 *    matches nothing).
 *
 * Spoolman is the record of what's on the shelf, so a filament variant it
 * has nothing for is out of stock (and the manufacturer is assumed to have
 * it). A variant whose filaments are all discontinued is sold while it's on
 * the shelf and then taken off sale, since it can't be ordered in. Resins
 * aren't kept in Spoolman and keep Shopify's stock.
 */
import { extraField, isDiscontinued, restockDate, type SpoolmanFilament, type SpoolmanInventory } from './spoolman';
import type { ShopifyProduct, ShopifyVariant } from './shopify';

/** Extra field (on filaments) holding the numeric Shopify variant id. */
const VARIANT_ID_FIELD = 'shopify_variant_id';

export function applyInventory(products: ShopifyProduct[], inventory: SpoolmanInventory, isFilament: (p: ShopifyProduct) => boolean) {
	const linked = new Map<string, SpoolmanFilament[]>();
	const unlinked: SpoolmanFilament[] = [];
	for (const f of inventory.filaments) {
		const id = extraField(f, VARIANT_ID_FIELD)?.trim().split('/').pop();
		if (id) linked.set(id, [...(linked.get(id) ?? []), f]);
		else unlinked.push(f);
	}

	const byName: string[] = [];
	const missing: string[] = [];
	for (const product of products.filter(isFilament)) {
		for (const variant of product.variants.nodes) {
			if (!variant.availableForSale) continue;
			const label = `${product.title} / ${variant.title}`;
			let filaments = linked.get(variant.id.split('/').pop()!) ?? [];
			if (!filaments.length) {
				filaments = byNameMatch(product, variant, unlinked);
				(filaments.length ? byName : missing).push(label);
			}
			const inStock = filaments.some((f) => inventory.onHand.has(f.id));
			// The manufacturer is out only if every matching filament has an ETA; the earliest one counts.
			const dates = filaments.map(restockDate);
			const restock = inStock || !dates.length || dates.some((d) => !d) ? undefined : (dates as string[]).sort()[0];
			const discontinued = filaments.length > 0 && filaments.every(isDiscontinued);
			if (discontinued && !inStock) variant.availableForSale = false;
			variant.stock = { inStock, restock: discontinued ? undefined : restock, discontinued };
		}
	}
	if (byName.length) console.info(`Spoolman: ${byName.length} variants matched by name (no ${VARIANT_ID_FIELD}): ${byName.join(', ')}`);
	if (missing.length) console.warn(`Spoolman: ${missing.length} variants not in Spoolman, shown as out of stock: ${missing.join(', ')}`);
}

function byNameMatch(product: ShopifyProduct, variant: ShopifyVariant, filaments: SpoolmanFilament[]): SpoolmanFilament[] {
	const colorOption = variant.selectedOptions.find((o) => /colou?r/i.test(o.name))?.value ?? (variant.title === 'Default Title' ? '' : variant.title);
	const colorWords = words(colorOption.replace(/\s*\([^)]*\)\s*$/, ''));
	const titleWords = new Set([...words(product.title), ...words(variant.title)]);
	const hex = hexOf(variant.metafields.find((m) => m?.key === 'color')?.value);

	const scored = filaments
		.filter((f) => [...words(f.material)].every((w) => titleWords.has(w)))
		.map((f) => ({ f, own: new Set([...words(f.material), ...words(f.name)]) }))
		.filter(({ own }) => [...colorWords].every((w) => own.has(w)))
		.map(({ f, own }) => {
			const shared = [...own].filter((w) => titleWords.has(w)).length;
			const extra = own.size - shared;
			return { f, score: shared - extra + (hex && hexOf(f.color_hex) === hex ? 0.5 : 0) };
		})
		.sort((a, b) => b.score - a.score);
	if (!scored.length || (scored[1] && scored[1].score === scored[0].score)) return [];
	return [scored[0].f];
}

function hexOf(value: string | null | undefined) {
	const hex = value?.trim().replace(/^#/, '').toLowerCase().slice(0, 6);
	return hex && /^[0-9a-f]{6}$/.test(hex) ? hex : undefined;
}

function words(text: string | null | undefined) {
	return new Set(text?.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}
