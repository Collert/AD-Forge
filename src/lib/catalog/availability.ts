/**
 * Per-variant filament rules the configurator applies on both the server and
 * the client: which nozzles a colour variant is approved for, and when a
 * variant that's short of stock for a job will be ready (from its supplier
 * ETA in `custom.supplier_eta`).
 *
 * Kept free of runtime imports so it can be unit-tested with `node --test`.
 */

/** Dates (ETAs, "today") are calendar days in the shop's time zone. */
export const SHOP_TIME_ZONE = 'America/Vancouver';
/** Days from the supplier delivering to the material being ready to print. */
export const ETA_BUFFER_DAYS = 3;
/** Lead time quoted when a variant is short and has no (upcoming) supplier ETA. */
export const NO_ETA_DAYS = { min: 3, max: 5 };

/** `custom.approved_nozzles` (a JSON list like ["0.4","0.6"]) as sizes; undefined when unset or unreadable. */
export function parseNozzles(value: string | undefined): number[] | undefined {
	try {
		const list = JSON.parse(value ?? '');
		if (!Array.isArray(list)) return undefined;
		const sizes = list.map(Number).filter((n) => Number.isFinite(n) && n > 0);
		return sizes.length ? [...new Set(sizes)].sort((a, b) => a - b) : undefined;
	} catch {
		return undefined;
	}
}

/** Nozzle sizes a variant can print with: its approved list, else every size the shop has. */
export function allowedNozzles(variantNozzles: number[] | undefined, all: number[]): number[] {
	const allowed = variantNozzles?.filter((n) => all.includes(n));
	return allowed?.length ? allowed : all;
}

/**
 * The nozzle to keep after the selected variant changes: the current one if
 * it's still allowed, else the nearest allowed size (ties go to `preferred`).
 */
export function revalidateNozzle(current: number, allowed: number[], preferred: number): number {
	if (!allowed.length || allowed.includes(current)) return current;
	const distance = (n: number) => Math.abs(n - current) + Math.abs(n - preferred) / 100;
	return [...allowed].sort((a, b) => distance(a) - distance(b))[0];
}

/** A variant's stock position: units on hand (1 unit = 1 g; null when untracked) and supplier ETA. */
export type Supply = { available: number | null; supplierEta?: string };

export type Availability =
	| { inStock: true }
	| {
			inStock: false;
			/** YYYY-MM-DD the material should be ready (for no-ETA variants, the end of the 3–5 day window). */
			readyDate: string;
			/** True when `readyDate` comes from a supplier ETA; false for the generic 3–5 days. */
			fromEta: boolean;
			message: string;
	  };

/** Today's date (YYYY-MM-DD) in the shop's time zone. */
export function shopToday(now: Date = new Date()): string {
	// en-CA formats as YYYY-MM-DD.
	return new Intl.DateTimeFormat('en-CA', { timeZone: SHOP_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A calendar date plus `days`. */
export function addDays(date: string, days: number): string {
	const d = new Date(`${date}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

/** "Wed, Nov 11, 2026" for a YYYY-MM-DD date. */
export function formatDate(date: string): string {
	return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
		timeZone: 'UTC',
		weekday: 'short',
		month: 'short',
		day: 'numeric',
		year: 'numeric'
	});
}

/** The supplier ETA if it's a valid date that hasn't passed; past or malformed ETAs count as empty. */
export function upcomingEta(eta: string | undefined, today: string): string | undefined {
	const value = eta?.trim().slice(0, 10);
	return value && DATE.test(value) && value >= today ? value : undefined;
}

/** Enough on hand for `neededGrams`? Untracked inventory always is. */
export function hasEnough(supply: Supply, neededGrams: number): boolean {
	return supply.available === null || supply.available >= neededGrams;
}

/** Whether a variant covers what the job needs, and if not, when it will be ready. */
export function availability(supply: Supply, neededGrams: number, now: Date = new Date()): Availability {
	if (hasEnough(supply, neededGrams)) return { inStock: true };
	const today = shopToday(now);
	const eta = upcomingEta(supply.supplierEta, today);
	if (eta) {
		const readyDate = addDays(eta, ETA_BUFFER_DAYS);
		return { inStock: false, readyDate, fromEta: true, message: `Not in stock — estimated arrival ${formatDate(readyDate)}` };
	}
	return {
		inStock: false,
		readyDate: addDays(today, NO_ETA_DAYS.max),
		fromEta: false,
		message: `Not in stock — ships in about ${NO_ETA_DAYS.min}–${NO_ETA_DAYS.max} days`
	};
}

/**
 * When every material of a multi-material job is ready: the latest of the
 * short materials' dates. Null when everything is in stock.
 */
export function materialReadyDate(items: Availability[]): { date: string; fromEta: boolean; message: string } | null {
	const short = items.filter((a): a is Extract<Availability, { inStock: false }> => !a.inStock);
	if (!short.length) return null;
	const latest = short.reduce((a, b) => (b.readyDate > a.readyDate || (b.readyDate === a.readyDate && !b.fromEta) ? b : a));
	const when = latest.fromEta ? formatDate(latest.readyDate) : `about ${formatDate(latest.readyDate)}`;
	return { date: latest.readyDate, fromEta: latest.fromEta, message: `Materials ready: ${when}` };
}
