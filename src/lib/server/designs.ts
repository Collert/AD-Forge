/**
 * A customer's finalized designs: the store products whose `custom.owner`
 * metafield is their email. Read with the Admin API, because these products
 * are unlisted and the Storefront API can neither list them nor filter by
 * metafield.
 *
 * The Admin token must never reach the browser. Until SHOPIFY_ADMIN_TOKEN is
 * set, no finalized designs are listed or created. Creating them needs the
 * write_products and write_publications scopes.
 */
import { env } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import { processes } from '$lib/catalog/config';

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
		// Product search lags a little behind new products: fetch the customer's newest ones directly.
		const missing = (recentlyCreated.get(email) ?? []).filter((r) => Date.now() - r.at < SEARCH_LAG_MS && !products.some((p) => p.id === r.id));
		for (const { id } of missing) {
			const { product } = await admin<{ product: AdminProduct | null }>(`query Design($id: ID!) { product(id: $id) { ${PRODUCT_FIELDS} } }`, { id });
			if (product) products.unshift(product);
		}
		const designs = products.filter((p) => p.status !== 'DRAFT' && ownedBy(p, email)).map(toDesign);
		cache.set(email, { at: Date.now(), designs });
		return { ok: true, designs };
	} catch (err) {
		console.error('Could not load finalized designs', err);
		return { ok: false, reason: 'error', designs: [] };
	}
}

/** How long a new product may be missing from product search. */
const SEARCH_LAG_MS = 10 * 60_000;
/** Designs created by this server recently, by owner, so the Library shows them before search catches up. */
const recentlyCreated = new Map<string, { id: string; at: number }[]>();

/** Forget a customer's cached list, e.g. after extending a design. */
export function invalidateDesigns(email: string) {
	cache.delete(email);
}

export type RenewResult = { ok: true; design: FinalizedDesign } | { ok: false; status: 404 | 409 | 503; message: string };

/**
 * Restart a design's retention clock: it is kept for RETENTION_DAYS from today.
 * Sets `custom.last_interaction` to today rather than adding time, so renewing
 * repeatedly can't push the date further out.
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

/** A `custom` metafield of a new design. */
export type DesignField = { key: string; value: string; type: string };

export type NewDesign = {
	email: string;
	name: string;
	/** Stored model's file name (.3mf for FDM, .pwscene for SLA, .step for CNC). */
	fileName: string;
	/** Configurator process id; stored as `custom.manufacturing_method` (its badge: "FDM", "SLA"…) and picks the category. */
	processId: string;
	/** "PETG HF - Red", "6061 Aluminum". */
	material: string;
	/** The method's own settings (layer height, infill, stock, setups…). */
	details: DesignField[];
	/** Part weight, g. */
	grams: number;
	/** $ per unit. */
	price: number;
	/** PNG preview for the product image. */
	thumbnail: Uint8Array<ArrayBuffer> | null;
	/** Heavy meshes are checked by hand before their first print. */
	manualReview: boolean;
};

/**
 * Product category by process kind. Printed parts are a print service; Shopify
 * has no machining-service category, so machined parts go under Manufacturing.
 */
const DESIGN_CATEGORIES: Record<string, string> = {
	extrusion: 'gid://shopify/TaxonomyCategory/se-3-3-1', // Services > Business Services > Office Services > Printing & Custom Print Services
	resin: 'gid://shopify/TaxonomyCategory/se-3-3-1',
	machining: 'gid://shopify/TaxonomyCategory/bi-17' // Business & Industrial > Manufacturing
};

/**
 * Create the unlisted store product a customer orders a finalized design
 * through: owned by them (`custom.owner`), priced at the quote, weighed for
 * shipping, and published to the storefront channel so the cart can add it.
 */
export async function createDesign(design: NewDesign): Promise<{ id: string; handle: string; variantId: string }> {
	if (!env.SHOPIFY_ADMIN_DOMAIN || !env.SHOPIFY_ADMIN_TOKEN) throw new Error('SHOPIFY_ADMIN_DOMAIN and SHOPIFY_ADMIN_TOKEN must be set.');
	const process = processes.find((p) => p.id === design.processId);
	if (!process) throw new Error(`Unknown process ${design.processId}`);

	// A missing preview shouldn't lose the order.
	const image =
		design.thumbnail &&
		(await uploadImage(design.thumbnail, `${design.fileName.replace(/\.\w+$/, '')}.png`).catch((err) => {
			console.error('Could not upload the design preview', err);
			return null;
		}));
	const today = new Date().toISOString().slice(0, 10);
	const text = (key: string, value: string) => ({ namespace: 'custom', key, value, type: 'single_line_text_field' });

	type Created = { productCreate: { product: { id: string; handle: string; variants: { nodes: { id: string }[] } } | null; userErrors: { message: string }[] } };
	const { productCreate } = await admin<Created>(
		`mutation Create($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
			productCreate(product: $product, media: $media) {
				product { id handle variants(first: 1) { nodes { id } } }
				userErrors { message }
			}
		}`,
		{
			product: {
				title: design.name,
				handle: `${slug(design.name)}-${slug(design.email.split('@')[0])}-${crypto.randomUUID().slice(0, 8)}`,
				descriptionHtml: '<p><strong>Custom 3D printed product</strong></p><p>This is a custom 3D printed item created specifically for you.</p>',
				vendor: 'AD-Customs',
				status: 'UNLISTED',
				category: DESIGN_CATEGORIES[process.kind],
				tags: design.manualReview ? ['manual-review'] : [],
				metafields: [
					text('owner', design.email),
					text('file_name', design.fileName),
					text('print_material', design.material),
					text('manufacturing_method', process.badge),
					...design.details.map((field) => ({ namespace: 'custom', ...field })),
					{ namespace: 'custom', key: 'added_date', value: today, type: 'date' },
					// Starts the retention clock (see RETENTION_DAYS).
					{ namespace: 'custom', key: 'last_interaction', value: today, type: 'date' }
				]
			},
			media: image ? [{ originalSource: image, mediaContentType: 'IMAGE', alt: `3D render of ${design.name}` }] : []
		}
	);
	const product = productCreate.product;
	if (!product || productCreate.userErrors.length) throw new Error(`Shopify productCreate: ${productCreate.userErrors.map((e) => e.message).join('; ')}`);
	const variantId = product.variants.nodes[0]?.id;
	if (!variantId) throw new Error(`Shopify created ${product.id} without a variant`);

	type Updated = { productVariantsBulkUpdate: { userErrors: { message: string }[] } };
	const { productVariantsBulkUpdate } = await admin<Updated>(
		`mutation Price($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
			productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { message } }
		}`,
		{
			productId: product.id,
			variants: [
				{
					id: variantId,
					price: design.price.toFixed(2),
					inventoryPolicy: 'CONTINUE',
					inventoryItem: { tracked: false, requiresShipping: true, measurement: { weight: { value: Math.max(1, Math.round(design.grams)), unit: 'GRAMS' } } }
				}
			]
		}
	);
	if (productVariantsBulkUpdate.userErrors.length) {
		throw new Error(`Shopify productVariantsBulkUpdate: ${productVariantsBulkUpdate.userErrors.map((e) => e.message).join('; ')}`);
	}

	if (env.SHOPIFY_STOREFRONT_PUBLICATION_ID) {
		type Published = { publishablePublish: { userErrors: { message: string }[] } };
		const { publishablePublish } = await admin<Published>(
			`mutation Publish($id: ID!, $input: [PublicationInput!]!) { publishablePublish(id: $id, input: $input) { userErrors { message } } }`,
			{ id: product.id, input: [{ publicationId: env.SHOPIFY_STOREFRONT_PUBLICATION_ID }] }
		);
		if (publishablePublish.userErrors.length) throw new Error(`Shopify publishablePublish: ${publishablePublish.userErrors.map((e) => e.message).join('; ')}`);
		await waitForStorefront(variantId);
	}

	const recent = (recentlyCreated.get(design.email) ?? []).filter((r) => Date.now() - r.at < SEARCH_LAG_MS);
	recentlyCreated.set(design.email, [...recent, { id: product.id, at: Date.now() }]);
	invalidateDesigns(design.email);
	return { id: product.id, handle: product.handle, variantId };
}

/**
 * A newly published product takes a few seconds to reach the Storefront API.
 * Until it does, the variant resolves but its product is null, and a cart
 * holding it fails every query ("Cannot return null for non-nullable field
 * ProductVariant.product"). So don't hand it to the cart before then.
 */
async function waitForStorefront(variantId: string, timeoutMs = 30_000) {
	const query = `query($id: ID!) { node(id: $id) { ... on ProductVariant { product { id } } } }`;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`https://${publicEnv.PUBLIC_SHOPIFY_STORE_DOMAIN}/api/${ADMIN_API_VERSION}/graphql.json`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'X-Shopify-Storefront-Access-Token': publicEnv.PUBLIC_SHOPIFY_STOREFRONT_TOKEN ?? '' },
				body: JSON.stringify({ query, variables: { id: variantId } }),
				signal: AbortSignal.timeout(10_000)
			});
			const body: { data?: { node: { product: { id: string } } | null } } = await res.json();
			if (body.data?.node?.product) return;
		} catch {
			// Not visible yet (the null product comes back as an error) or a network blip: try again.
		}
		await new Promise((r) => setTimeout(r, 1500));
	}
	console.warn(`Design variant ${variantId} not on the storefront after ${timeoutMs / 1000}s; the cart will keep retrying.`);
}

/** Upload a PNG to Shopify's staging storage; the returned URL can be attached as product media. */
async function uploadImage(png: Uint8Array<ArrayBuffer>, filename: string): Promise<string> {
	type Staged = { stagedUploadsCreate: { stagedTargets: { url: string; resourceUrl: string; parameters: { name: string; value: string }[] }[]; userErrors: { message: string }[] } };
	const { stagedUploadsCreate } = await admin<Staged>(
		`mutation Stage($input: [StagedUploadInput!]!) {
			stagedUploadsCreate(input: $input) { stagedTargets { url resourceUrl parameters { name value } } userErrors { message } }
		}`,
		{ input: [{ resource: 'IMAGE', filename, mimeType: 'image/png', httpMethod: 'POST', fileSize: String(png.byteLength) }] }
	);
	const target = stagedUploadsCreate.stagedTargets[0];
	if (!target) throw new Error(`Shopify stagedUploadsCreate: ${stagedUploadsCreate.userErrors.map((e) => e.message).join('; ')}`);

	const form = new FormData();
	for (const { name, value } of target.parameters) form.append(name, value);
	form.append('file', new Blob([png], { type: 'image/png' }), filename);
	const res = await fetch(target.url, { method: 'POST', body: form, signal: AbortSignal.timeout(30_000) });
	if (!res.ok) throw new Error(`Image upload responded ${res.status} ${res.statusText}`);
	return target.resourceUrl;
}

function slug(text: string) {
	return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'part';
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
	const setups = field(product, 'cnc_setups');
	const variant = product.variants.nodes[0];
	const format = fileName?.match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase() ?? null;
	// Designs saved before `custom.manufacturing_method` existed: a Photon Workshop scene is SLA,
	// anything else with a material is FDM.
	const method = field(product, 'manufacturing_method');
	const processId = processes.find((p) => p.badge === method)?.id ?? (format === 'pwscene' ? 'sla' : material ? 'fdm' : null);

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
		format,
		processId,
		imageUrl: product.featuredMedia?.preview?.image?.url ?? null,
		variantId: variant?.id ?? null,
		price: variant ? Number(variant.price) : null,
		availableForSale: variant?.availableForSale ?? false,
		specs: (processId === 'cnc'
			? [material, field(product, 'cnc_axes'), field(product, 'cnc_stock_size'), setups && `${setups} ${setups === '1' ? 'Setup' : 'Setups'}`]
			: [
					material,
					layer && `${layer} Layers`,
					infill && (processId === 'sla' ? (infill === '0' ? 'Hollow' : 'Solid') : `${infill}% Infill`),
					nozzle && `${nozzle} mm Nozzle`
				]
		).filter((s): s is string => !!s),
		expiresAt: new Date(expires).toISOString(),
		daysLeft,
		status: daysLeft <= 0 || product.status === 'ARCHIVED' ? 'archived' : daysLeft <= EXPIRING_DAYS ? 'expiring' : 'active',
		inProduction: product.tags.some((t) => /needs? printing/i.test(t))
	};
}

function field(product: AdminProduct, key: string) {
	return product.metafields.nodes.find((m) => m.key === key)?.value;
}
