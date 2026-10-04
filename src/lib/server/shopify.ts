/**
 * Minimal Shopify Storefront API client: reads the products the configurator
 * sells (filaments, resins and CNC stock) with the metafields it needs.
 */
import { env } from '$env/dynamic/public';

const API_VERSION = '2026-07';

/** Product types (in Shopify admin) the catalog is built from. */
export const PRINT_MATERIAL_TYPE = '3D Print material';
export const CNC_STOCK_TYPE = 'CNC Raw Material';

export type Metafield = { key: string; value: string } | null;

export type ShopifyVariant = {
	id: string;
	title: string;
	availableForSale: boolean;
	quantityAvailable: number | null;
	price: { amount: string };
	selectedOptions: { name: string; value: string }[];
	/** In `VARIANT_METAFIELDS` order; null where unset. */
	metafields: Metafield[];
};

export type ShopifyProduct = {
	id: string;
	handle: string;
	title: string;
	productType: string;
	tags: string[];
	description: string;
	availableForSale: boolean;
	collections: { nodes: { handle: string; title: string }[] };
	/** In `PRODUCT_METAFIELDS` order; null where unset. */
	metafields: Metafield[];
	variants: { nodes: ShopifyVariant[] };
};

export type ShopifyCollection = { handle: string; title: string; products: { nodes: { handle: string }[] } };

const PRODUCT_METAFIELDS = [
	'density',
	'requires_enclosure',
	'uom_abbreviation',
	'technical_datasheet',
	'cnc_3_axis_compatible',
	'cnc_4_axis_compatible',
	'stock_material',
	'stock_shape',
	'orca_filament',
	'approved_nozzles'
];
const VARIANT_METAFIELDS = ['color', 'secondary_color', 'thickness_mm', 'width_mm', 'length_mm', 'diameter_mm'];

const identifiers = (keys: string[]) => `[${keys.map((k) => `{namespace: "custom", key: "${k}"}`).join(', ')}]`;

const PRODUCTS_QUERY = `
query Catalog($query: String!, $after: String) {
	products(first: 100, after: $after, query: $query) {
		pageInfo { hasNextPage endCursor }
		nodes {
			id handle title productType tags description availableForSale
			collections(first: 25) { nodes { handle title } }
			metafields(identifiers: ${identifiers(PRODUCT_METAFIELDS)}) { key value }
			variants(first: 100) {
				nodes {
					id title availableForSale quantityAvailable
					price { amount }
					selectedOptions { name value }
					metafields(identifiers: ${identifiers(VARIANT_METAFIELDS)}) { key value }
				}
			}
		}
	}
}`;

const COLLECTIONS_QUERY = `
query Collections($after: String) {
	collections(first: 100, after: $after) {
		pageInfo { hasNextPage endCursor }
		nodes { handle title products(first: 250) { nodes { handle } } }
	}
}`;

type Page<T> = { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: T[] };

async function storefront<T>(query: string, variables: Record<string, unknown>): Promise<T> {
	const domain = env.PUBLIC_SHOPIFY_STORE_DOMAIN;
	const token = env.PUBLIC_SHOPIFY_STOREFRONT_TOKEN;
	if (!domain || !token) throw new Error('PUBLIC_SHOPIFY_STORE_DOMAIN and PUBLIC_SHOPIFY_STOREFRONT_TOKEN must be set (see .env.example).');

	const res = await fetch(`https://${domain}/api/${API_VERSION}/graphql.json`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-Shopify-Storefront-Access-Token': token },
		body: JSON.stringify({ query, variables }),
		signal: AbortSignal.timeout(15_000)
	});
	if (!res.ok) throw new Error(`Shopify Storefront API responded ${res.status} ${res.statusText}`);
	const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
	if (body.errors?.length) throw new Error(`Shopify Storefront API: ${body.errors.map((e) => e.message).join('; ')}`);
	return body.data!;
}

/** Every page of a connection. */
async function all<T>(query: string, key: string, variables: Record<string, unknown> = {}): Promise<T[]> {
	const nodes: T[] = [];
	let after: string | null = null;
	do {
		const data: Record<string, Page<T>> = await storefront(query, { ...variables, after });
		const page = data[key];
		nodes.push(...page.nodes);
		after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
	} while (after);
	return nodes;
}

/** Filament, resin and CNC stock products, plus every collection (to find the filament categories). */
export async function fetchStoreData() {
	const query = [PRINT_MATERIAL_TYPE, CNC_STOCK_TYPE].map((t) => `product_type:"${t}"`).join(' OR ');
	const [products, collections] = await Promise.all([
		all<ShopifyProduct>(PRODUCTS_QUERY, 'products', { query }),
		all<ShopifyCollection>(COLLECTIONS_QUERY, 'collections')
	]);
	return { products, collections };
}

/** Product metafields by key. */
export function productFields(product: ShopifyProduct) {
	return fieldMap(product.metafields);
}

/** Variant metafields by key. */
export function variantFields(variant: ShopifyVariant) {
	return fieldMap(variant.metafields);
}

function fieldMap(metafields: Metafield[]): Record<string, string | undefined> {
	return Object.fromEntries(metafields.filter((m) => m !== null).map((m) => [m.key, m.value]));
}
