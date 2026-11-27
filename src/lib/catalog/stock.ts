/**
 * How long a material takes to reach us, and how we say so. On the shelf: we
 * start right away. Not on the shelf: we order it when the order comes in and
 * it arrives in `restockBusinessDays`. If the manufacturer is out too, those
 * business days count from their restock ETA.
 */

/** Business days an ordered spool takes to reach us, once the manufacturer has it. */
export const restockBusinessDays = [1, 2] as const;

export type Availability = {
	inStock: boolean;
	/** The manufacturer's restock ETA (ISO date) when they're out too. */
	restock?: string;
	/** Discontinued by the manufacturer (only ever offered while on hand). */
	discontinued?: boolean;
};

/** For a colour on the shelf that the manufacturer has discontinued. */
export const discontinuedNote =
	"This colour has been discontinued by the manufacturer. We still have some on the shelf, but once it's gone we can't restock it.";

/** `date` moved forward by `days` business days (Saturdays and Sundays skipped). */
function addBusinessDays(date: Date, days: number) {
	const d = new Date(date);
	while (days > 0) {
		d.setDate(d.getDate() + 1);
		if (d.getDay() !== 0 && d.getDay() !== 6) days--;
	}
	return d;
}

/** The ETA if it's still ahead, else today (local midnight). */
function restockFrom(restock: string | undefined, today = new Date()) {
	const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
	if (!restock) return { start, waiting: false };
	const [y, m, d] = restock.split('-').map(Number);
	const eta = new Date(y, m - 1, d);
	return eta > start ? { start: eta, waiting: true } : { start, waiting: false };
}

const dayFmt = new Intl.DateTimeFormat('en-CA', { month: 'short', day: 'numeric' });

/** "Dec 15–16", "Dec 31 – Jan 1". */
function dateRange(a: Date, b: Date) {
	if (a.getMonth() === b.getMonth()) return `${dayFmt.format(a)}–${b.getDate()}`;
	return `${dayFmt.format(a)} – ${dayFmt.format(b)}`;
}

export type LeadTime = {
	/** Short status for a badge: "In Stock", "Arrives in 1–2 days", "Arrives Dec 15–16". */
	badge: string;
	/** A sentence explaining it; unset when in stock. */
	note?: string;
	/** The manufacturer is out of stock too. */
	waiting: boolean;
};

export function leadTime(a: Availability, today = new Date()): LeadTime {
	if (a.inStock) return { badge: 'In Stock', waiting: false };
	const [lo, hi] = restockBusinessDays;
	const { start, waiting } = restockFrom(a.restock, today);
	if (!waiting) {
		return {
			badge: `Arrives in ${lo}–${hi} days`,
			note: `Out of stock here, but we order it the moment you place your order. It usually arrives in ${lo}–${hi} business days, then we start printing.`,
			waiting
		};
	}
	const arrives = dateRange(addBusinessDays(start, lo), addBusinessDays(start, hi));
	return {
		badge: `Arrives ${arrives}`,
		note: `The manufacturer is out of stock until around ${dayFmt.format(start)}. We order it as soon as you place your order, and it usually reaches us ${lo}–${hi} business days after it's back (about ${arrives}), then we start printing.`,
		waiting
	};
}
