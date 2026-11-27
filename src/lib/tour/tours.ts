import type { Process } from '$lib/catalog/config';

/** One stop on a guided tour. */
export type TourStep = {
	/** `data-tour` value of the element to spotlight; none shows a centered card. Steps whose element isn't on the page are skipped. */
	target?: string;
	title: string;
	body: string;
};

export type Tour = {
	/** Stored once finished or skipped, so the tour isn't offered again. */
	id: string;
	steps: TourStep[];
};

/** Steps every method's tour shares, so the wording stays the same across them. */
const welcome = (method: string): TourStep => ({
	title: 'Welcome to the Workbench',
	body: `This quick tour shows you how to go from a 3D model to an ${method} order. It takes about a minute. Press Next to go step by step, or skip it any time.`
});

const viewerSteps: TourStep[] = [
	{
		target: 'viewer',
		title: 'Add your model',
		body: 'Drag and drop an STL, OBJ, 3MF, PLY or STEP file onto the preview, or use the upload button in its toolbar. Until you do, you’re looking at a sample part.'
	},
	{
		target: 'viewer-tools',
		title: 'Check it from every angle',
		body: 'Switch camera views, rotate or scale the part, measure it, and highlight overhangs that will need supports. In the rotate tool, Try to Fit Build Plate finds an orientation that fits the printer.'
	}
];

const partName: TourStep = {
	target: 'part-name',
	title: 'Name your part',
	body: 'This is the name you’ll see on your Shelf, in your cart and on your order. It starts as the file name.'
};

const orderSteps: TourStep[] = [
	{
		target: 'quote',
		title: 'Get your price',
		body: 'The estimate updates live as you change settings. Press Get Accurate Quote to slice your model with your exact settings and lock in the real price. Ordering several? Bulk discounts apply automatically at checkout.'
	},
	{
		target: 'quote-cta',
		title: 'Confirm and order',
		body: 'Once you have an accurate quote, this button becomes Confirm & Upload. If you aren’t signed in yet, you’ll sign in or create a free account first. Your part is then saved to My Designs and added to your cart, ready for checkout.'
	},
	{
		target: 'shelf',
		title: 'Saved as you go',
		body: 'Every model you upload is kept on your Shelf in this browser, with its settings, so you can pick up where you left off.'
	}
];

const finish = (heading: string): TourStep => ({
	title: 'You’re ready',
	body: `Upload a model to get started. You can replay this tour any time with “Take the tour” under the ${heading} heading.`
});

/** FDM ordering, Simple tab only (Advanced users already know their way around). */
const fdmTour: Tour = {
	id: 'fdm',
	steps: [
		welcome('FDM print'),
		{
			target: 'method',
			title: 'Pick a manufacturing method',
			body: 'You’re on FDM 3D printing: plastic parts built up layer by layer. You can switch methods here any time, and your part comes with you.'
		},
		...viewerSteps,
		{
			target: 'health',
			title: 'Review model health',
			body: 'We check your mesh for holes, overhangs and walls too thin to print. Each warning says what to fix, and Auto-Repair Mesh can close small holes for you.'
		},
		partName,
		{
			target: 'mode',
			title: 'Simple or Advanced',
			body: 'Simple covers the four settings most parts need, with sensible defaults. If you know your way around a slicer, switch to Advanced for walls, supports, infill patterns, dimensional compensation and surface finish.'
		},
		{
			target: 'material',
			title: '1. Material & color',
			body: 'Pick a category, polymer and color. The price per gram and stock status update as you choose. The ? buttons explain any setting.'
		},
		{
			target: 'quality',
			title: '2. Surface quality',
			body: 'Thinner layers give a smoother surface but take longer to print. Standard suits most parts.'
		},
		{
			target: 'infill',
			title: '3. Infill density',
			body: 'How solid the inside of the part is. More infill is stronger and heavier, and costs more. Use a preset or drag the slider.'
		},
		{
			target: 'nozzle',
			title: '4. Level of detail',
			body: 'A smaller nozzle prints finer details, more slowly. 0.4 mm is the standard choice; some materials only allow certain sizes.'
		},
		...orderSteps,
		finish('print configuration')
	]
};

/** SLA resin ordering. */
const slaTour: Tour = {
	id: 'sla',
	steps: [
		welcome('SLA resin print'),
		{
			target: 'method',
			title: 'Pick a manufacturing method',
			body: 'You’re on SLA resin printing: liquid resin cured by UV light in very thin layers, for fine detail and smooth surfaces. You can switch methods here any time, and your part comes with you.'
		},
		...viewerSteps,
		{
			target: 'health',
			title: 'Review model health',
			body: 'We check your mesh for holes and for details too fine for resin to form, and show where supports and drain holes will go. Each warning says what to fix, and Auto-Repair Mesh can close small holes for you.'
		},
		partName,
		{
			target: 'resin',
			title: '1. Resin & pigment',
			body: 'Pick a resin type, then a pigment. Strength, stretch and heat resistance are listed under the name, and the price per ml updates as you choose. The ? buttons explain any setting.'
		},
		{
			target: 'resin-layer',
			title: '2. Layer resolution',
			body: 'Resin layers are already far finer than FDM, so layer lines are nearly invisible at any setting. Go finer for jewelry and miniatures; Draft is quicker for fit checks.'
		},
		{
			target: 'resin-shell',
			title: '3. Solid or hollow',
			body: 'Solid is stiffest. Hollow prints a thick outer shell instead, using much less resin and costing less; we add small drain holes in a hidden spot during review.'
		},
		{
			target: 'resin-post',
			title: '4. Wash & cure, included',
			body: 'Every resin part is washed, UV-cured to full strength, and has its supports removed and sanded smooth. Nothing to choose here, and it’s already in the price.'
		},
		...orderSteps,
		finish('resin print configuration')
	]
};

/** The tour for a manufacturing method, if it has one. */
export function tourFor(process: Process): Tour | null {
	return process.kind === 'extrusion' ? fdmTour : process.kind === 'resin' ? slaTour : null;
}

const STORAGE_KEY = 'ad-forge:tours-done';

function readDone(): Record<string, number> {
	try {
		return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') ?? {};
	} catch {
		return {};
	}
}

/** True once this browser has finished or skipped the tour. */
export function isTourDone(id: string): boolean {
	return id in readDone();
}

export function markTourDone(id: string) {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readDone(), [id]: Date.now() }));
	} catch {
		// Storage blocked (private mode): the tour may be offered again next visit.
	}
}
