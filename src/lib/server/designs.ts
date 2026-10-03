/**
 * A customer's finalized designs: the store products whose `custom.owner`
 * metafield is their email. Read with the Admin API, because these products
 * are unlisted and the Storefront API can neither list them nor filter by
 * metafield.
 *
 * TODO(backend): move this to your own backend and call it from here. The
 * Admin token must never reach the browser. Until SHOPIFY_ADMIN_TOKEN is set,
 * no finalized designs are listed.
 */
import { env } from '$env/dynamic/private';

const ADMIN_API_VERSION = '2026-07';

/** Days a finalized model is kept after its last interaction (added, ordered or renewed). */
export const RETENTION_DAYS = 90;
/** Days left at which a design counts as expiring soon. */
export const EXPIRING_DAYS = 7;

/** How long a customer's design list is reused before re-reading Shopify. */
const CACHE_MS = 60_000;

export type DesignStatus = 'active' | 'expiring' | 'archived';

export type FinalizedDesign = {
	/** Shopify product gid. */
	id: string;
	handle: string;
	name: string;
	/** Uploaded model file name, e.g. "Lid_65c16bd1.stl". */
	fileName: string | null;
	/** Lower-case extension of the uploaded model, e.g. "stl". */
	format: string | null;
	/** Configurator process id, when known. */
	processId: string | null;
	imageUrl: string | null;
	/** Shopify variant gid to add to the cart. */
	variantId: string | null;
	/** $ per unit. */
	price: number | null;
	availableForSale: boolean;
	specs: string[];
	/** ISO date the model is deleted. */
	expiresAt: string;
	daysLeft: number;
	status: DesignStatus;
	/** Waiting to be printed. */
	inProduction: boolean;
};

export type DesignsResult =
	| { ok: true; designs: FinalizedDesign[] }
	| { ok: false; reason: 'not-configured' | 'signed-out' | 'error'; designs: [] };

type AdminProduct = {
	id: string;
	handle: string;
	title: string;
	status: 'ACTIVE' | 'ARCHIVED' | 'DRAFT' | 'UNLISTED';
	tags: string[];
	createdAt: string;
	featuredMedia: { preview: { image: { url: string } | null } | null } | null;
	metafields: { nodes: { key: string; value: string }[] };
	variants: { nodes: { id: string; price: string; availableForSale: boolean }[] };
};

const PRODUCT_FIELDS = `
	id handle title status tags createdAt
	featuredMedia { preview { image { url(transform: { maxWidth: 800 }) } } }
	metafields(first: 30, namespace: "custom") { nodes { key value } }
	variants(first: 1) { nodes { id price availableForSale } }`;

const DESIGNS_QUERY = `
query Designs($query: String!, $after: String) {
	products(first: 100, after: $after, query: $query, sortKey: UPDATED_AT, reverse: true) {
		pageInfo { hasNextPage endCursor }
		nodes { ${PRODUCT_FIELDS} }
	}
}`;

const cache = new Map<string, { at: number; designs: FinalizedDesign[] }>();

export async function getFinalizedDesigns(email: string): Promise<DesignsResult> {
	if (!env.SHOPIFY_ADMIN_DOMAIN || !env.SHOPIFY_ADMIN_TOKEN) return { ok: false, reason: 'not-configured', designs: [] };

	const hit = cache.get(email);
	if (hit && Date.now() - hit.at < CACHE_MS) return { ok: true, designs: hit.designs };

	try {
		const products = await fetchOwnedProducts(email);
		const designs = products.filter((p) => p.status !== 'DRAFT' && ownedBy(p, email)).map(toDesign);
		cache.set(email, { at: Date.now(), designs });
		return { ok: true, designs };
	} catch (err) {
		console.error('Could not load finalized designs', err);
		return { ok: false, reason: 'error', designs: [] };
	}
}

/** Forget a customer's cached list, e.g. after extending a design. */
export function invalidateDesigns(email: string) {
	cache.delete(email);
}

export type RenewResult = { ok: true; design: FinalizedDesign } | { ok: false; status: 404 | 409 | 503; message: string };

/**
 * Restart a design's retention clock: it is kept for RETENTION_DAYS from today.
 * Sets `custom.last_interaction` to today rather than adding time, so renewing
 * repeatedly can't push the date further out.
 *
 * TODO(backend): move this to your own backend with the rest of the Admin API calls.
 */
export async function renewDesign(email: string, productId: string): Promise<RenewResult> {
	if (!env.SHOPIFY_ADMIN_DOMAIN || !env.SHOPIFY_ADMIN_TOKEN) return { ok: false, status: 503, message: 'Renewing designs is not available right now.' };

	const { product } = await admin<{ product: AdminProduct | null }>(`query Design($id: ID!) { product(id: $id) { ${PRODUCT_FIELDS} } }`, { id: productId });
	// Someone else's design gets the same answer as a missing one.
	if (!product || product.status === 'DRAFT' || !ownedBy(product, email)) return { ok: false, status: 404, message: 'Design not found.' };
	const current = toDesign(product);
	if (current.status === 'archived') {
		return { ok: false, status: 409, message: 'This design has expired and can no longer be renewed. Upload it again to reorder.' };
	}
	if (current.daysLeft >= RETENTION_DAYS) return { ok: true, design: current };

	const today = new Date().toISOString().slice(0, 10);
	const { metafieldsSet } = await admin<{ metafieldsSet: { userErrors: { message: string }[] } }>(
		`mutation Renew($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { userErrors { message } } }`,
		{ metafields: [{ ownerId: product.id, namespace: 'custom', key: 'last_interaction', type: 'date', value: today }] }
	);
	if (metafieldsSet.userErrors.length) throw new Error(`Shopify Admin API: ${metafieldsSet.userErrors.map((e) => e.message).join('; ')}`);

	invalidateDesigns(email);
	const others = product.metafields.nodes.filter((m) => m.key !== 'last_interaction');
	return { ok: true, design: toDesign({ ...product, metafields: { nodes: [...others, { key: 'last_interaction', value: today }] } }) };
}

async function fetchOwnedProducts(email: string): Promise<AdminProduct[]> {
	const query = `metafields.custom.owner:"${email.replace(/["\\]/g, '')}"`;
	const products: AdminProduct[] = [];
	let after: string | null = null;
	do {
		type Page = { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: AdminProduct[] };
		const { products: page }: { products: Page } = await admin(DESIGNS_QUERY, { query, after });
		products.push(...page.nodes);
		after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
	} while (after);
	return products;
}

async function admin<T>(query: string, variables: Record<string, unknown>): Promise<T> {
	const res = await fetch(`https://${env.SHOPIFY_ADMIN_DOMAIN}/admin/api/${ADMIN_API_VERSION}/graphql.json`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': env.SHOPIFY_ADMIN_TOKEN! },
		body: JSON.stringify({ query, variables }),
		signal: AbortSignal.timeout(15_000)
	});
	if (!res.ok) throw new Error(`Shopify Admin API responded ${res.status} ${res.statusText}`);
	const body: { data?: T; errors?: { message: string }[] } = await res.json();
	if (body.errors?.length) throw new Error(`Shopify Admin API: ${body.errors.map((e) => e.message).join('; ')}`);
	return body.data!;
}

/** The owner filter in product search matches loosely, so check the value exactly. */
function ownedBy(product: AdminProduct, email: string) {
	return field(product, 'owner')?.trim().toLowerCase() === email;
}

function toDesign(product: AdminProduct): FinalizedDesign {
	const fileName = field(product, 'file_name') ?? null;
	const material = field(product, 'print_material');
	const layer = field(product, 'layer_height');
	const infill = field(product, 'infill_percentage');
	const nozzle = field(product, 'nozzle_size');
	const variant = product.variants.nodes[0];

	// Kept for RETENTION_DAYS after `custom.last_interaction` (last ordered or extended). Designs
	// without it yet count from when they were added.
	const since = [field(product, 'last_interaction'), field(product, 'added_date'), product.createdAt]
		.map((d) => (d ? Date.parse(d) : NaN))
		.find((t) => Number.isFinite(t))!;
	const expires = since + RETENTION_DAYS * 86_400_000;
	const daysLeft = Math.ceil((expires - Date.now()) / 86_400_000);

	return {
		id: product.id,
		handle: product.handle,
		name: product.title,
		fileName,
		format: fileName?.match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase() ?? null,
		processId: material ? 'fdm' : null,
		imageUrl: product.featuredMedia?.preview?.image?.url ?? null,
		variantId: variant?.id ?? null,
		price: variant ? Number(variant.price) : null,
		availableForSale: variant?.availableForSale ?? false,
		specs: [
			material,
			layer && `${layer} Layers`,
			infill && `${infill}% Infill`,
			nozzle && `${nozzle} mm Nozzle`
		].filter((s): s is string => !!s),
		expiresAt: new Date(expires).toISOString(),
		daysLeft,
		status: daysLeft <= 0 || product.status === 'ARCHIVED' ? 'archived' : daysLeft <= EXPIRING_DAYS ? 'expiring' : 'active',
		inProduction: product.tags.some((t) => /needs? printing/i.test(t))
	};
}

function field(product: AdminProduct, key: string) {
	return product.metafields.nodes.find((m) => m.key === key)?.value;
}
