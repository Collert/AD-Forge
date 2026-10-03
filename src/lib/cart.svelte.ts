/**
 * The shopper's Shopify cart, kept with the Storefront Cart API straight from
 * the browser (public token), so adding items never leaves the page. The cart
 * id is remembered in localStorage; checkout opens Shopify's checkout URL.
 *
 * Only variants published to the Headless channel can be added. Finalized
 * designs must be published there when they are created (Admin API,
 * `publishablePublish` with SHOPIFY_STOREFRONT_PUBLICATION_ID).
 */
import { env } from '$env/dynamic/public';

const API_VERSION = '2026-07';
const STORAGE_KEY = 'ad-forge:cart-id';
/** Quantity edits wait this long for more clicks before saving. */
const QUANTITY_DEBOUNCE_MS = 400;
export const MAX_LINE_QUANTITY = 999;

export type CartLine = {
	/** Shopify cart line gid. */
	id: string;
	variantId: string;
	title: string;
	/** Variant name, when the product has more than one. */
	variantTitle: string | null;
	imageUrl: string | null;
	/** Regular price of one unit. */
	unitPrice: number;
	/** Units on screen; may be ahead of Shopify while an edit is saving. */
	quantity: number;
	/** Units Shopify priced: the money fields below are for this quantity. */
	pricedQuantity: number;
	/** Line price before discounts, from Shopify. */
	subtotal: number;
	/** Line price after the discounts Shopify applied (volume discounts etc.). */
	total: number;
	discounts: CartDiscount[];
};

export type CartDiscount = { title: string; amount: number };

/**
 * All money comes from Shopify's cart, so automatic discounts (including app
 * discounts such as volume tiers) show exactly as they will at checkout.
 */
export const cart = $state({
	id: null as string | null,
	checkoutUrl: null as string | null,
	lines: [] as CartLine[],
	currency: 'CAD',
	/** Items after line discounts, before order discounts and taxes. */
	subtotal: 0,
	/** Order-level discounts. */
	orderDiscounts: [] as CartDiscount[],
	/** After all discounts, before shipping and taxes calculated at checkout. */
	total: 0,
	/** Variant ids being added right now. */
	adding: [] as string[],
	/** Unsaved or in-flight line edits. */
	syncing: 0,
	/** Last failed edit, for the cart panel. */
	error: null as string | null,
	open: false
});

/** Units in the cart, including edits not yet saved. */
export function cartQuantity() {
	return cart.lines.reduce((n, l) => n + l.quantity, 0);
}

export function lineFor(variantId: string) {
	return cart.lines.find((l) => l.variantId === variantId);
}

const DISCOUNT_FIELDS = `
	discountedAmount { amount }
	... on CartAutomaticDiscountAllocation { title }
	... on CartCustomDiscountAllocation { title }
	... on CartCodeDiscountAllocation { code }`;

const CART_FIELDS = `
	id checkoutUrl
	cost { subtotalAmount { amount currencyCode } totalAmount { amount } }
	discountAllocations { ${DISCOUNT_FIELDS} }
	lines(first: 100) {
		nodes {
			id quantity
			cost { amountPerQuantity { amount } subtotalAmount { amount } totalAmount { amount } }
			discountAllocations { ${DISCOUNT_FIELDS} }
			merchandise {
				... on ProductVariant {
					id title
					image { url(transform: { maxWidth: 160 }) }
					product { title featuredImage { url(transform: { maxWidth: 160 }) } }
				}
			}
		}
	}`;

type DiscountPayload = { discountedAmount: { amount: string }; title?: string; code?: string };

type CartPayload = {
	id: string;
	checkoutUrl: string;
	cost: { subtotalAmount: { amount: string; currencyCode: string }; totalAmount: { amount: string } };
	discountAllocations: DiscountPayload[];
	lines: {
		nodes: {
			id: string;
			quantity: number;
			cost: { amountPerQuantity: { amount: string }; subtotalAmount: { amount: string }; totalAmount: { amount: string } };
			discountAllocations: DiscountPayload[];
			merchandise: {
				id: string;
				title: string;
				image: { url: string } | null;
				product: { title: string; featuredImage: { url: string } | null };
			};
		}[];
	};
};
type CartResult = { cart: CartPayload | null; userErrors: { message: string }[] };

async function storefront<T>(query: string, variables: Record<string, unknown>): Promise<T> {
	const res = await fetch(`https://${env.PUBLIC_SHOPIFY_STORE_DOMAIN}/api/${API_VERSION}/graphql.json`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-Shopify-Storefront-Access-Token': env.PUBLIC_SHOPIFY_STOREFRONT_TOKEN ?? '' },
		body: JSON.stringify({ query, variables })
	});
	if (!res.ok) throw new Error(`The store responded ${res.status}.`);
	const body = await res.json();
	if (body.errors?.length) throw new Error(body.errors[0].message);
	return body.data;
}

function apply(payload: CartPayload | null) {
	cart.id = payload?.id ?? null;
	cart.checkoutUrl = payload?.checkoutUrl ?? null;
	cart.subtotal = Number(payload?.cost.subtotalAmount.amount ?? 0);
	cart.total = Number(payload?.cost.totalAmount.amount ?? 0);
	cart.currency = payload?.cost.subtotalAmount.currencyCode ?? cart.currency;
	cart.orderDiscounts = toDiscounts(payload?.discountAllocations ?? []);
	const saved = (payload?.lines.nodes ?? []).map(
		(l): CartLine => ({
			id: l.id,
			variantId: l.merchandise.id,
			title: l.merchandise.product.title,
			variantTitle: l.merchandise.title === 'Default Title' ? null : l.merchandise.title,
			imageUrl: l.merchandise.image?.url ?? l.merchandise.product.featuredImage?.url ?? null,
			unitPrice: Number(l.cost.amountPerQuantity.amount),
			quantity: l.quantity,
			pricedQuantity: l.quantity,
			subtotal: Number(l.cost.subtotalAmount.amount),
			total: Number(l.cost.totalAmount.amount),
			discounts: toDiscounts(l.discountAllocations)
		})
	);
	// Keep edits the shopper made while this response was in flight.
	cart.lines = saved.map((line) => (timers.has(line.id) ? { ...line, quantity: lineQuantity(line.id) ?? line.quantity } : line));
	try {
		if (cart.id) localStorage.setItem(STORAGE_KEY, cart.id);
		else localStorage.removeItem(STORAGE_KEY);
	} catch {
		// Storage blocked: the cart lasts for this page view.
	}
}

/** Discount allocations, merged by name ("Small batch", a code, …). */
function toDiscounts(allocations: DiscountPayload[]): CartDiscount[] {
	const byTitle = new Map<string, number>();
	for (const a of allocations) {
		const amount = Number(a.discountedAmount.amount);
		if (amount <= 0) continue;
		const title = a.title || a.code || 'Discount';
		byTitle.set(title, (byTitle.get(title) ?? 0) + amount);
	}
	return [...byTitle].map(([title, amount]) => ({ title, amount }));
}

/** True while a line's quantity differs from what Shopify last priced. */
export function isRepricing(line: CartLine) {
	return line.quantity !== line.pricedQuantity;
}

function lineQuantity(id: string) {
	return cart.lines.find((l) => l.id === id)?.quantity;
}

function check(result: CartResult | null, fallback: string) {
	if (result?.userErrors.length) throw new Error(friendly(result.userErrors[0].message));
	if (!result?.cart) throw new Error(fallback);
	apply(result.cart);
}

/** Pick up the cart from a previous visit (it's dropped if Shopify no longer has it, e.g. after checkout). */
export async function restoreCart() {
	let id: string | null = null;
	try {
		id = localStorage.getItem(STORAGE_KEY);
	} catch {
		return;
	}
	if (!id || cart.id) return;
	try {
		const data = await storefront<{ cart: CartPayload | null }>(`query($id: ID!) { cart(id: $id) { ${CART_FIELDS} } }`, { id });
		apply(data.cart);
	} catch {
		// Offline or blocked: keep the stored id and try again next time.
	}
}

/** Add units of a variant (to its existing line, if any). Throws with a customer-facing message on failure. */
export async function addToCart(variantId: string, quantity = 1) {
	const existing = lineFor(variantId);
	if (existing) return setQuantity(existing.id, existing.quantity + quantity);

	cart.adding = [...cart.adding, variantId];
	try {
		const lines = [{ merchandiseId: variantId, quantity }];
		let result: CartResult | null = null;
		if (cart.id) {
			const data = await storefront<{ cartLinesAdd: CartResult }>(
				`mutation($id: ID!, $lines: [CartLineInput!]!) { cartLinesAdd(cartId: $id, lines: $lines) { cart { ${CART_FIELDS} } userErrors { message } } }`,
				{ id: cart.id, lines }
			);
			result = data.cartLinesAdd;
		}
		// No cart yet, or the stored one is gone (checked out / expired): start a new one.
		if (!result?.cart) {
			if (result?.userErrors.length && !/cart/i.test(result.userErrors[0].message)) throw new Error(friendly(result.userErrors[0].message));
			const data = await storefront<{ cartCreate: CartResult }>(
				`mutation($lines: [CartLineInput!]!) { cartCreate(input: { lines: $lines }) { cart { ${CART_FIELDS} } userErrors { message } } }`,
				{ lines }
			);
			result = data.cartCreate;
		}
		check(result, 'Could not add this item to your cart.');
	} finally {
		cart.adding = cart.adding.filter((id) => id !== variantId);
	}
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Change a line's quantity. Updates at once on screen and saves after a short
 * pause, so several clicks become one request. 0 removes the line.
 */
export function setQuantity(lineId: string, quantity: number) {
	const line = cart.lines.find((l) => l.id === lineId);
	if (!line) return;
	const next = Math.max(0, Math.min(MAX_LINE_QUANTITY, Math.round(quantity) || 0));
	if (next === 0) return removeLine(lineId);
	line.quantity = next;
	cart.error = null;

	if (timers.has(lineId)) clearTimeout(timers.get(lineId));
	else cart.syncing++;
	timers.set(
		lineId,
		setTimeout(async () => {
			try {
				const data = await storefront<{ cartLinesUpdate: CartResult }>(
					`mutation($id: ID!, $lines: [CartLineUpdateInput!]!) { cartLinesUpdate(cartId: $id, lines: $lines) { cart { ${CART_FIELDS} } userErrors { message } } }`,
					{ id: cart.id, lines: [{ id: lineId, quantity: lineQuantity(lineId) ?? next }] }
				);
				timers.delete(lineId);
				check(data.cartLinesUpdate, 'Could not update the quantity.');
			} catch (err) {
				timers.delete(lineId);
				cart.error = (err as Error).message;
				await restoreFromShopify();
			} finally {
				cart.syncing--;
			}
		}, QUANTITY_DEBOUNCE_MS)
	);
}

/** Take a line out of the cart. */
export async function removeLine(lineId: string) {
	if (timers.has(lineId)) {
		clearTimeout(timers.get(lineId));
		timers.delete(lineId);
		cart.syncing--;
	}
	const before = cart.lines;
	cart.lines = cart.lines.filter((l) => l.id !== lineId);
	cart.error = null;
	cart.syncing++;
	try {
		const data = await storefront<{ cartLinesRemove: CartResult }>(
			`mutation($id: ID!, $lineIds: [ID!]!) { cartLinesRemove(cartId: $id, lineIds: $lineIds) { cart { ${CART_FIELDS} } userErrors { message } } }`,
			{ id: cart.id, lineIds: [lineId] }
		);
		check(data.cartLinesRemove, 'Could not remove this item.');
	} catch (err) {
		cart.lines = before;
		cart.error = (err as Error).message;
	} finally {
		cart.syncing--;
	}
}

/** Re-read the cart after a failed edit so the screen matches what Shopify has. */
async function restoreFromShopify() {
	if (!cart.id) return;
	try {
		const data = await storefront<{ cart: CartPayload | null }>(`query($id: ID!) { cart(id: $id) { ${CART_FIELDS} } }`, { id: cart.id });
		apply(data.cart);
	} catch {
		// Leave the optimistic state; the error is already shown.
	}
}

function friendly(message: string) {
	return /does not exist|merchandise/i.test(message)
		? "This design isn't available for online ordering yet. Contact us to reorder it."
		: message;
}
