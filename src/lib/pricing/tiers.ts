/**
 * The volume tiers as shown to customers. Informational only: Shopify applies
 * the real discounts in the cart and at checkout.
 */
import { priceTiers, type PriceTier } from '$lib/catalog/config';

/** $ off each unit at a tier, after the process's multiplier. */
export function tierAmountOff(tier: PriceTier, tierScale = 1) {
	return tier.amountOff * tierScale;
}

/** One unit's price at a tier; a discount never takes it below $0. */
export function tierUnitPrice(total: number, tier: PriceTier, tierScale = 1) {
	return Math.max(0, total - tierAmountOff(tier, tierScale));
}

/** The lowest unit price on offer (the biggest tier), or null when no tier lowers it. */
export function lowestUnitPrice(total: number, tierScale = 1): { price: number; tier: PriceTier } | null {
	const tier = priceTiers[priceTiers.length - 1];
	const price = tierUnitPrice(total, tier, tierScale);
	return price < total ? { price, tier } : null;
}
