/**
 * Turn an accurate quote into an orderable design: keep its file (an
 * OrcaSlicer project for FDM and a Photon Workshop scene for SLA, both with the
 * customer's preview added; the customer's STEP file for CNC) in
 * MODELS_DIR/<customer>/<name>_<id>.<ext>, and create the store product it's
 * ordered through. Safe to repeat: a quote is finalized once.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '$env/dynamic/private';
import { axisModes, largeMeshTriangles, qualities, resinQualities, type QualityOption } from '$lib/catalog/config';
import { createDesign, type DesignField } from './designs';
import { dataDir, getQuote, type QuoteRecord } from './slicer/quotes';
import { withPwscenePreview } from './slicer/pwscene';
import { withThumbnail } from './slicer/threemf';

export type Finalized = { productId: string; handle: string; variantId: string; fileName: string };

export class FinalizeError extends Error {
	constructor(
		readonly status: 404 | 410,
		message: string
	) {
		super(message);
	}
}

const DESIGN_FILE = 'design.json';
const pending = new Map<string, Promise<Finalized>>();

export function modelsDir() {
	return path.resolve(env.MODELS_DIR || path.join(dataDir(), 'models'));
}

export function finalizeQuote(quoteId: string, email: string, name: string, thumbnail: Uint8Array<ArrayBuffer> | null): Promise<Finalized> {
	// A double click waits for the first request instead of creating a second product.
	let job = pending.get(quoteId);
	if (!job) {
		job = finalize(quoteId, email, name, thumbnail).finally(() => pending.delete(quoteId));
		pending.set(quoteId, job);
	}
	return job;
}

async function finalize(quoteId: string, email: string, name: string, thumbnail: Uint8Array<ArrayBuffer> | null): Promise<Finalized> {
	const found = await getQuote(quoteId);
	if (!found) throw new FinalizeError(410, 'This quote has expired. Get a new quote to order this part.');
	const { record, dir, projectFile } = found;

	const done = await readFile(path.join(dir, DESIGN_FILE), 'utf8').then(
		(text) => JSON.parse(text) as Finalized & { email: string },
		() => null
	);
	if (done) {
		if (done.email !== email) throw new FinalizeError(404, 'Quote not found.');
		return done;
	}

	const title = name.trim().slice(0, 120) || record.name;
	const fileName = `${safe(title)}_${randomUUID().slice(0, 8)}${path.extname(record.file)}`;
	const folder = path.join(modelsDir(), safe(email.replace('@', '_at_')));
	const file = path.join(folder, fileName);
	const project = await readFile(projectFile);
	await mkdir(folder, { recursive: true });
	// The preview goes inside project files; a STEP file is kept exactly as uploaded.
	const withPreview = record.kind === 'resin' ? withPwscenePreview : record.kind === 'extrusion' ? withThumbnail : null;
	await writeFile(file, thumbnail && withPreview ? withPreview(project, thumbnail) : project);

	try {
		const { material, quote } = record;
		const product = await createDesign({
			email,
			name: title,
			fileName,
			processId: record.processId,
			material: record.kind === 'machining' ? material.name : `${material.name} - ${material.color}`,
			details: detailsOf(record),
			grams: quote.grams,
			price: quote.total,
			thumbnail,
			manualReview: record.triangles > largeMeshTriangles
		});
		const result: Finalized = { productId: product.id, handle: product.handle, variantId: product.variantId, fileName };
		await writeFile(path.join(dir, DESIGN_FILE), JSON.stringify({ ...result, email }));
		return result;
	} catch (err) {
		await rm(file, { force: true });
		throw err;
	}
}

/** The method's settings as `custom` metafields on the product. */
function detailsOf(record: QuoteRecord): DesignField[] {
	const text = (key: string, value: string) => ({ key, value, type: 'single_line_text_field' });
	const integer = (key: string, value: number) => ({ key, value: String(value), type: 'number_integer' });
	switch (record.kind) {
		case 'extrusion':
			return [
				text('layer_height', qualityOf(qualities, record.settings.layerHeight)),
				integer('infill_percentage', record.settings.infill),
				text('nozzle_size', record.settings.nozzle.toFixed(1))
			];
		case 'resin':
			return [text('layer_height', qualityOf(resinQualities, record.settings.layerHeight)), integer('infill_percentage', record.settings.hollow ? 0 : 100)];
		case 'machining': {
			const { x, y, z } = record.rotation;
			return [
				text('cnc_axes', axisModes.find((m) => m.id === record.settings.axes)!.label),
				integer('cnc_setups', record.setups),
				text('cnc_stock_size', record.stock),
				text('cnc_orientation', x || y || z ? `Rotated X ${x}°, Y ${y}°, Z ${z}° from the STEP file` : 'As in the STEP file')
			];
		}
	}
}

/** A configurator quality as the store's layer-height choice (SLA's Ultra Detail counts as Fine). */
function qualityOf(list: QualityOption[], layerHeight: number) {
	const id = list.find((q) => q.layerHeight === layerHeight)?.id;
	return id === 'draft' ? 'Draft' : id === 'standard' ? 'Standard' : 'Fine';
}

/** Safe as a file or folder name on any OS. */
function safe(text: string) {
	return text.replace(/[^\w.-]+/g, '_').replace(/^[._]+|_+$/g, '').slice(0, 80) || 'part';
}
