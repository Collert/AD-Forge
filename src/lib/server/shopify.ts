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
	image: ShopifyImage | null;
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
	descriptionHtml: string;
	seo: { description: string | null };
	availableForSale: boolean;
	images: { nodes: ShopifyImage[] };
	collections: { nodes: { handle: string; title: string }[] };
	/** In `PRODUCT_METAFIELDS` order; null where unset. */
	metafields: Metafield[];
	/** `custom.technical_data`, a `material_technical_data` metaobject. */
	technicalData: { reference: { fields: { key: string; value: string | null }[] } | null } | null;
	variants: { nodes: ShopifyVariant[] };
};

/** A product image on Shopify's CDN, which resizes it on request (see `shopifyImageUrl`). */
export type ShopifyImage = { url: string; altText: string | null; width: number | null; height: number | null };

export type ShopifyCollection = {
	handle: string;
	title: string;
	description: string;
	/** `custom.process`, e.g. "FDM": the collection is a tier of that process's Materials Library tab. */
	process: { value: string } | null;
	products: { nodes: { handle: string }[] };
};

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
	'approved_nozzles',
	'technical_datasheets',
	'rating_strength',
	'rating_heat',
	'rating_flexibility',
	'rating_finish',
	'molecule',
	'great_for',
	'pick_something_else_for',
	'design_tips'
];
const VARIANT_METAFIELDS = [
	'color',
	'secondary_color',
	'thickness_mm',
	'width_mm',
	'length_mm',
	'diameter_mm',
	'approved_nozzles',
	'supplier_eta'
];

const IMAGE_FIELDS = 'url altText width height';

const identifiers = (keys: string[]) => `[${keys.map((k) => `{namespace: "custom", key: "${k}"}`).join(', ')}]`;

const PRODUCTS_QUERY = `
query Catalog($query: String!, $after: String) {
	products(first: 100, after: $after, query: $query) {
		pageInfo { hasNextPage endCursor }
		nodes {
			id handle title productType tags description descriptionHtml availableForSale
			seo { description }
			images(first: 100) { nodes { ${IMAGE_FIELDS} } }
			collections(first: 25) { nodes { handle title } }
			metafields(identifiers: ${identifiers(PRODUCT_METAFIELDS)}) { key value }
			technicalData: metafield(namespace: "custom", key: "technical_data") {
				reference { ... on Metaobject { fields { key value } } }
			}
			variants(first: 100) {
				nodes {
					id title availableForSale quantityAvailable
					price { amount }
					selectedOptions { name value }
					image { ${IMAGE_FIELDS} }
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
		nodes {
			handle title description
			process: metafield(namespace: "custom", key: "process") { value }
			products(first: 250) { nodes { handle } }
		}
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

export type StoreData = { products: ShopifyProduct[]; collections: ShopifyCollection[]; fetchedAt: number };

/** Filament, resin and CNC stock products, plus every collection (to find the filament categories). */
async function fetchStoreData(): Promise<StoreData> {
	const query = [PRINT_MATERIAL_TYPE, CNC_STOCK_TYPE].map((t) => `product_type:"${t}"`).join(' OR ');
	const [products, collections] = await Promise.all([
		all<ShopifyProduct>(PRODUCTS_QUERY, 'products', { query }),
		all<ShopifyCollection>(COLLECTIONS_QUERY, 'collections')
	]);
	return { products, collections, fetchedAt: Date.now() };
}

/** How long fetched store data is served before it's refreshed in the background. */
const FRESH_MS = 5 * 60_000;

let cached: StoreData | null = null;
let pending: Promise<StoreData> | null = null;

/**
 * The store's material products and collections, cached in memory: requests
 * within `FRESH_MS` of the last fetch are served straight from the cache;
 * after that the cached copy is still served instantly while a fresh one loads
 * in the background (stale-while-revalidate). If Shopify is unreachable the
 * last good copy keeps being served.
 */
export async function getStoreData(): Promise<StoreData> {
	if (cached && Date.now() - cached.fetchedAt < FRESH_MS) return cached;
	pending ??= fetchStoreData()
		.then((data) => (cached = data))
		.finally(() => (pending = null));
	if (!cached) return pending;
	pending.catch((err) => console.error('Shopify refresh failed; serving the cached copy.', err));
	return cached;
}

/** Derive something from the store data once per fetch; the result is reused until the next refresh. */
export function fromStoreData<T>(build: (data: StoreData) => T): () => Promise<T> {
	const built = new WeakMap<StoreData, T>();
	return async () => {
		const data = await getStoreData();
		if (!built.has(data)) built.set(data, build(data));
		return built.get(data)!;
	};
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
